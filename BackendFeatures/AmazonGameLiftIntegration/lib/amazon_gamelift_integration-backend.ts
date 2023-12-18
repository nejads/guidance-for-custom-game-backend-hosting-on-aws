import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import * as assets from 'aws-cdk-lib/aws-s3-assets';
import * as path from 'path';
import * as gamelift from 'aws-cdk-lib/aws-gamelift';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

// Define custom stack properties
interface AmazonGameLiftIntegrationBackendProps extends cdk.StackProps {
  issuerEndpointUrl : string;
}

export class AmazonGameLiftIntegrationBackend extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AmazonGameLiftIntegrationBackendProps) {
    super(scope, id, props);

    // Define an SNS topic as the FlexMatch notification target
    const topic = new sns.Topic(this, 'FlexMatchEventsTopic');

    // Add a policy that allows gamelift.amazonaws.com to publish events
    topic.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['sns:Publish'],
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('gamelift.amazonaws.com')],
      resources: [topic.topicArn],
    }));

    // Export the SNS topic ARN as an output for the GameLift stack to use
    new cdk.CfnOutput(this, 'SnsTopicArn', {
      value: topic.topicArn,
      description: 'The ARN of the SNS topic used for FlexMatch notifications',
      exportName: 'AmazonGameLiftSampleSnsTopicArn',
    });

    //// HTTP API ////

    // HTTP Api for the backend
    const httpApi = new apigateway.CfnApi(this, 'AmazonGameLiftIntegrationApi', {
      name: 'AmazonGameLiftIntegrationApi',
      protocolType: 'HTTP',
      description: 'Amazon GameLift Integration HTTP API',
    });
    // Define a log group for the HTTP Api logs
    const httpApiLogGroup = new logs.LogGroup(this, 'AmazonGameLiftIntegrationApiLogs', {
    });

    // Define a auto deployed Stage for the HTTP Api
    const httpApiStage = new apigateway.CfnStage(this, 'HttpApiProdStage', {
      apiId: httpApi.ref,
      stageName: 'prod',
      autoDeploy: true,
      accessLogSettings: {
        destinationArn: httpApiLogGroup.logGroupArn,
        format: '$context.requestId $context.requestTime $context.resourcePath $context.httpMethod $context.status $context.protocol'
      }
    });

    // Access point for the API
    new CfnOutput(this, 'AmazonGameLiftIntegrationBackendEndpointUrl', { value: httpApi.attrApiEndpoint + "/prod"});
    
    // Authorizer that uses our custom identity solution
    const authorizer = new apigateway.CfnAuthorizer(this, 'BackendAuthorizer', {
      apiId: httpApi.ref,
      name: 'BackendAuthorizer',
      authorizerType: 'JWT',
      identitySource: ['$request.header.Authorization'],
      jwtConfiguration: {
        audience: ['gamebackend'],
        issuer: props.issuerEndpointUrl
      }
    });

    // LAMBDA FUNCTIONS ///

    // The shared policy for basic Lambda access needs for logging. This is similar to the managed Lambda Execution Policy
    const lambdaBasicPolicy = new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup','logs:CreateLogStream','logs:PutLogEvents'],
      resources: ['*'],
    });

    // The shared role for the custom resources that set up Lambda logging
    const logsManagementPolicy = new iam.PolicyStatement({
      actions: ['logs:DeleteRetentionPolicy','logs:PutRetentionPolicy'],
      resources: ['*'],
    } );
    const lambdaLoggingRole = new iam.Role(this, 'LambdaLoggingRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        'LambdaLoggingPolicy': new iam.PolicyDocument({
          statements: [logsManagementPolicy],
        }),
        'LambdaBasicPolicy': new iam.PolicyDocument({
          statements: [lambdaBasicPolicy],
        })
      }
    });

    // Define functions to request matchmaking and check match status
    const request_matchmaking_function_role = new iam.Role(this, 'RequestMatchmakingFunctionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    request_matchmaking_function_role.addToPolicy(lambdaBasicPolicy);
    // Add GameLift API access to the role
    request_matchmaking_function_role.addToPolicy(new iam.PolicyStatement({
      actions: ['gamelift:StartMatchmaking'],
      resources: ['*'],
      effect: iam.Effect.ALLOW
    }));
    const request_matchmaking = new lambda.Function(this, 'RequestMatchmaking', {
      role: request_matchmaking_function_role,
      code: lambda.Code.fromAsset("lambda", {
        bundling: {
          image: lambda.Runtime.PYTHON_3_11.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -ru . /asset-output'
          ],
      },}),
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'request_matchmaking.lambda_handler',
      timeout: Duration.seconds(15),
      tracing: lambda.Tracing.ACTIVE,
      memorySize: 1024,
      logRetention: logs.RetentionDays.ONE_MONTH,
      logRetentionRole: lambdaLoggingRole,
      environment: {
        "MATCHMAKING_CONFIGURATION": "SampleFlexMatchConfiguration" // NOTE: We're using a fixed name here that we know the other stack will use!
      }
    });

    // Allow the HttpApi to invoke the set_player_data function
    request_matchmaking.addPermission('InvokeSetPlayerDataFunction', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceAccount: this.account,
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.ref}/prod/*`,
      action: 'lambda:InvokeFunction'
    });

    NagSuppressions.addResourceSuppressions(request_matchmaking_function_role, [
      { id: 'AwsSolutions-IAM5', reason: 'Using the standard Lambda execution role, all custom access resource restricted.' }
    ], true);

    // Define set-player-data integration and route
    const requestMatchmakingIntegration = new apigateway.CfnIntegration(this, 'RequestMatchmakingIntegration', {
      apiId: httpApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: request_matchmaking.functionArn,
      integrationMethod: 'GET',
      payloadFormatVersion: '2.0'
    });

    new apigateway.CfnRoute(this, 'RequestMatchmakingRoute', {
      apiId: httpApi.ref,
      routeKey: 'GET /request-matchmaking',
      authorizationType: 'JWT',
      authorizerId: authorizer.ref,
      target: "integrations/" + requestMatchmakingIntegration.ref,
      authorizationScopes: ["guest", "authenticated"]
    });
    
  }

}
