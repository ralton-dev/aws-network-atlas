import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, ListAccountAliasesCommand } from '@aws-sdk/client-iam';
import type { AwsContext } from './aws.js';

const execFileAsync = promisify(execFile);

/** Verify the AWS CLI is installed (the user's stated environment assumption). */
export async function verifyAwsCli(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('aws', ['--version']);
    return stdout.trim();
  } catch {
    throw new Error(
      'AWS CLI not found on PATH. Install it (https://aws.amazon.com/cli/) and configure your profiles before scanning.',
    );
  }
}

export interface CallerIdentity {
  accountId: string;
  arn: string;
}

/**
 * Verify credentials for the profile actually resolve, and get the account id.
 * Surfaces a helpful message for expired SSO sessions.
 */
export async function verifyCredentials(ctx: AwsContext): Promise<CallerIdentity> {
  const sts = ctx.client(STSClient, ctx.homeRegion);
  try {
    const res = await sts.send(new GetCallerIdentityCommand({}));
    if (!res.Account || !res.Arn) throw new Error('STS returned no identity');
    return { accountId: res.Account, arn: res.Arn };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : '';
    // The SDK surfaces expired SSO sessions as CredentialsProviderError /
    // TokenProviderError with an "aws sso login" hint in the message.
    if (
      name === 'CredentialsProviderError' ||
      name === 'TokenProviderError' ||
      /aws sso login|token.*expired|expired.*token/i.test(msg)
    ) {
      throw new Error(
        `Credentials for profile "${ctx.profile}" could not be resolved (expired SSO session?). ` +
          `Try: aws sso login --profile ${ctx.profile}\n(${msg})`,
      );
    }
    throw new Error(`Cannot authenticate with profile "${ctx.profile}": ${msg}`);
  }
}

/** IAM account alias, if one exists (nice display name for the diagram). */
export async function accountAlias(ctx: AwsContext): Promise<string | undefined> {
  try {
    const iam = ctx.client(IAMClient, ctx.homeRegion);
    const res = await iam.send(new ListAccountAliasesCommand({}));
    return res.AccountAliases?.[0];
  } catch {
    return undefined; // Not fatal — read-only roles often lack iam:ListAccountAliases.
  }
}
