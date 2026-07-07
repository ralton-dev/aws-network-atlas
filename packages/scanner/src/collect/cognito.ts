// Cognito — READ-ONLY (List*/Describe*/Get* only).
// User pools carry the auth posture (MFA, password policy, advanced security,
// OAuth app clients) and identity pools map federated identities onto IAM
// roles — both invisible to the tag sweep beyond ARN + name.
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  DescribeUserPoolClientCommand,
  GetUserPoolMfaConfigCommand,
  paginateListIdentityProviders,
  paginateListUserPoolClients,
  paginateListUserPools,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CognitoIdentityClient,
  DescribeIdentityPoolCommand,
  GetIdentityPoolRolesCommand,
  paginateListIdentityPools,
} from '@aws-sdk/client-cognito-identity';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectCognito(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  // Two independent guard blocks — a permission failure on one Cognito
  // service must not lose the other's resources.
  await guard(out.errors, 'cognito-idp', 'ListUserPools', async () => {
    const client = ctx.client(CognitoIdentityProviderClient, region);
    for await (const page of paginateListUserPools({ client }, { MaxResults: 60 })) {
      for (const summary of page.UserPools ?? []) {
        if (!summary.Id) continue;
        const poolId = summary.Id;

        const detail = await client.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
        const pool = detail.UserPool;

        const mfa = await client.send(new GetUserPoolMfaConfigCommand({ UserPoolId: poolId }));

        const appClients: RegionSnapshot['cognitoUserPools'][number]['appClients'] = [];
        for await (const clientPage of paginateListUserPoolClients(
          { client },
          { UserPoolId: poolId, MaxResults: 60 },
        )) {
          for (const c of clientPage.UserPoolClients ?? []) {
            if (!c.ClientId) continue;
            const cd = await client.send(
              new DescribeUserPoolClientCommand({ UserPoolId: poolId, ClientId: c.ClientId }),
            );
            const uc = cd.UserPoolClient;
            appClients.push({
              id: c.ClientId,
              name: uc?.ClientName ?? c.ClientName,
              allowedOAuthFlows: [...(uc?.AllowedOAuthFlows ?? [])],
              allowedOAuthScopes: [...(uc?.AllowedOAuthScopes ?? [])],
              callbackUrls: [...(uc?.CallbackURLs ?? [])],
              supportedIdentityProviders: [...(uc?.SupportedIdentityProviders ?? [])],
              explicitAuthFlows: [...(uc?.ExplicitAuthFlows ?? [])],
              generateSecret: uc?.ClientSecret !== undefined ? true : undefined,
            });
          }
        }

        const identityProviders: string[] = [];
        for await (const idpPage of paginateListIdentityProviders(
          { client },
          { UserPoolId: poolId, MaxResults: 60 },
        )) {
          for (const p of idpPage.Providers ?? []) {
            if (p.ProviderName) identityProviders.push(p.ProviderName);
          }
        }

        out.cognitoUserPools.push({
          id: poolId,
          arn: pool?.Arn,
          name: pool?.Name ?? summary.Name,
          tags: pool?.UserPoolTags ?? {},
          status: pool?.Status,
          mfaConfiguration: mfa.MfaConfiguration ?? pool?.MfaConfiguration,
          passwordMinimumLength: pool?.Policies?.PasswordPolicy?.MinimumLength,
          advancedSecurityMode: pool?.UserPoolAddOns?.AdvancedSecurityMode,
          deletionProtection: pool?.DeletionProtection,
          estimatedNumberOfUsers: pool?.EstimatedNumberOfUsers,
          domain: pool?.CustomDomain ?? pool?.Domain,
          identityProviders,
          appClients,
        });
      }
    }
  });

  await guard(out.errors, 'cognito-identity', 'ListIdentityPools', async () => {
    const client = ctx.client(CognitoIdentityClient, region);
    for await (const page of paginateListIdentityPools({ client }, { MaxResults: 60 })) {
      for (const summary of page.IdentityPools ?? []) {
        if (!summary.IdentityPoolId) continue;
        const poolId = summary.IdentityPoolId;

        const pool = await client.send(
          new DescribeIdentityPoolCommand({ IdentityPoolId: poolId }),
        );
        const roles = await client.send(
          new GetIdentityPoolRolesCommand({ IdentityPoolId: poolId }),
        );

        out.cognitoIdentityPools.push({
          id: poolId,
          name: pool.IdentityPoolName ?? summary.IdentityPoolName,
          tags: pool.IdentityPoolTags ?? {},
          allowUnauthenticatedIdentities: pool.AllowUnauthenticatedIdentities,
          allowClassicFlow: pool.AllowClassicFlow,
          cognitoUserPoolProviders: (pool.CognitoIdentityProviders ?? [])
            .map((p) => p.ClientId)
            .filter((c): c is string => !!c),
          samlProviderArns: [...(pool.SamlProviderARNs ?? [])],
          openIdConnectProviderArns: [...(pool.OpenIdConnectProviderARNs ?? [])],
          authenticatedRoleArn: roles.Roles?.['authenticated'],
          unauthenticatedRoleArn: roles.Roles?.['unauthenticated'],
        });
      }
    }
  });
}
