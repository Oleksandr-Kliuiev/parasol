import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * prisma/roles.sql rendered for one database, shared by the PGlite tests, scripts/pg17-check.ts and the PostgreSQL
 * harness, so every engine runs the PRODUCTION grant definitions (no test-only grants). Roles are cluster-wide: each
 * PostgreSQL database gets its own runtime/definer/runner/fence/PowerOffice definer/PowerOffice runner/remote definer names.
 * Only the role-name settings and the psql password variables are substituted, each of which must occur exactly once;
 * anything else means roles.sql changed shape.
 */
export interface RoleNames {
  runtime: string; definer: string; runner: string; fence: string; poDefiner: string; poRunner: string;
  /** Stage 5 ASK-REMOTE definer (NOLOGIN). Optional for callers that predate it: derived from the runtime name (remoteRoleName). */
  remote?: string;
  /** R-EVAL RS-A evidence definer (NOLOGIN) and evidence reader (LOGIN). Optional: derived from the runtime name (revalRoleNames). */
  revalDefiner?: string;
  revalReader?: string;
}
/**
 * Passwords of the LOGIN roles. The Stage 4 PowerOffice runner password is optional for callers that predate it (a random
 * local value is rendered when absent, never printed); the accepted Stage 2/3 texts have no such variable.
 */
export interface RoleSecrets { runtimePassword: string; runnerPassword: string; poRunnerPassword?: string; revalReaderPassword?: string }
/** The three roles of the accepted Stage 2 provisioning text (before the Stage 3 fence definer). */
export type Stage2RoleNames = Pick<RoleNames, 'runtime' | 'definer' | 'runner'>;
/** The four roles of the accepted Stage 3 provisioning texts (S3-A, S3-B, S3-C; before the Stage 4 PowerOffice roles). */
export type Stage3RoleNames = Pick<RoleNames, 'runtime' | 'definer' | 'runner' | 'fence'>;

const ROLE_SETTINGS: Readonly<Record<keyof RoleNames, [setting: string, defaultName: string]>> = {
  runtime: ['atlas.runtime_role', 'atlas_app'],
  definer: ['atlas.definer_role', 'atlas_m365_cleanup_definer'],
  runner: ['atlas.runner_role', 'atlas_m365_cleanup_runner'],
  fence: ['atlas.fence_role', 'atlas_action_fence_definer'],
  poDefiner: ['atlas.po_definer_role', 'atlas_poweroffice_cleanup_definer'],
  poRunner: ['atlas.po_runner_role', 'atlas_poweroffice_cleanup_runner'],
  remote: ['atlas.remote_role', 'atlas_ask_remote_definer'],
  revalDefiner: ['atlas.reval_definer_role', 'atlas_reval_evidence_definer'],
  revalReader: ['atlas.reval_reader_role', 'atlas_reval_reader'],
};
const PASSWORD_VARIABLES: Readonly<Record<keyof RoleSecrets, string>> = {
  runtimePassword: ":'atlas_app_password'", runnerPassword: ":'atlas_cleanup_runner_password'", poRunnerPassword: ":'atlas_poweroffice_runner_password'",
  revalReaderPassword: ":'atlas_reval_reader_password'",
};
/** The three password variables of the accepted texts before R-EVAL RS-A. */
const PRE_RSA_PASSWORDS: readonly (keyof RoleSecrets)[] = ['runtimePassword', 'runnerPassword', 'poRunnerPassword'];
const S5REMOTE_KEYS: readonly (keyof RoleNames)[] = ['runtime', 'definer', 'runner', 'fence', 'poDefiner', 'poRunner', 'remote'];
const STAGE3_KEYS: readonly (keyof RoleNames)[] = ['runtime', 'definer', 'runner', 'fence'];
const S5ASKB_KEYS: readonly (keyof RoleNames)[] = ['runtime', 'definer', 'runner', 'fence', 'poDefiner', 'poRunner'];
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const SECRET = /^[A-Za-z0-9]{16,128}$/;
/** SHA-256 of tests/support/roles-stage2.sql: the byte-exact accepted Stage 2 prisma/roles.sql (S3-A baseline). */
export const STAGE2_ROLES_SQL_SHA256 = 'c875edf89021e529570a2428658e3c578b426f5f00146d7174956e8afdf0f5b9';

/** SHA-256 of tests/support/roles-s3a.sql: the byte-exact accepted S3-A prisma/roles.sql (S3-B baseline). */
export const S3A_ROLES_SQL_SHA256 = '40ce17f17a33fd8824a031ad287bc68ee22976c6351febd41b1acaa1d221de8a';

/** SHA-256 of tests/support/roles-s3b.sql: the byte-exact accepted S3-B prisma/roles.sql (S3-C baseline). */
export const S3B_ROLES_SQL_SHA256 = 'ebd316dea232417eb82797a065cb66cc23401d6b16b7428dec4c34dd0935ba6b';

/** SHA-256 of tests/support/poweroffice-roles-s3c.sql: the byte-exact accepted S3-C prisma/roles.sql (S4-A baseline). */
export const S3C_ROLES_SQL_SHA256 = 'f3eafceb600e3d49f30c85d07a558faf373b2ed574288eb48767f673a4d42abc';

/**
 * SHA-256 of tests/support/roles-s5askb.sql: the byte-exact accepted prisma/roles.sql of the ASK-REMOTE R-A baseline
 * (S4-C through S5ASKB-rc2; verification/stage5/S5ASKREMOTE_RA_IMPLEMENTATION_BASELINE.json), before the remote definer.
 */
export const S5ASKB_ROLES_SQL_SHA256 = '9e35dd9ef76f94dbbf839c80b3c8f7c3421134e0049d90b31aed43a6099faceb';

/** SHA-256 of tests/support/roles-s5remote.sql: the byte-exact prisma/roles.sql of the R-EVAL RS-A baseline (R-A…R-C), before reval. */
export const S5REMOTE_ROLES_SQL_SHA256 = '7a9419b37d1d575ad073abf0837850350879ae9b15c018cc6f0c19809b0d3f69';
/** The psql include of prisma/roles.sql, inlined exactly once (pg clients and PGlite run the text without psql). */
const REVAL_INCLUDE = '\\ir roles/reval.sql';

/** prisma/roles.sql with its single `\ir roles/reval.sql` include inlined (what psql executes). */
export async function readRolesSql(): Promise<string> {
  const main = await readFile(new URL('../../prisma/roles.sql', import.meta.url), 'utf8');
  const lines = main.split('\n');
  if (lines.filter(l => l === REVAL_INCLUDE).length !== 1 || main.split('\\ir').length !== 2) throw new Error('prisma/roles.sql changed shape; update readRolesSql');
  const reval = await readFile(new URL('../../prisma/roles/reval.sql', import.meta.url), 'utf8');
  if (reval.includes('\\i')) throw new Error('prisma/roles/reval.sql must not include other files');
  return lines.map(l => l === REVAL_INCLUDE ? reval.replace(/\n$/, '') : l).join('\n');
}
/** The accepted pre-RS-A text (seven roles, three passwords), for upgrades to R-EVAL RS-A; refuses a changed fixture. */
export async function readS5RemoteRolesSql(): Promise<string> {
  const sql = await readFile(new URL('./roles-s5remote.sql', import.meta.url), 'utf8');
  if (createHash('sha256').update(sql).digest('hex') !== S5REMOTE_ROLES_SQL_SHA256) throw new Error('tests/support/roles-s5remote.sql changed');
  return sql;
}
/** The accepted S3-A text (four roles, no S3-B write grants), for upgrade tests from an S3-A deployment. */
export async function readS3aRolesSql(): Promise<string> {
  const sql = await readFile(new URL('./roles-s3a.sql', import.meta.url), 'utf8');
  if (createHash('sha256').update(sql).digest('hex') !== S3A_ROLES_SQL_SHA256) throw new Error('tests/support/roles-s3a.sql changed');
  return sql;
}
/** The accepted S3-B text (approval/reservation grants, no execution/verification writes), for upgrades from S3-B. */
export async function readS3bRolesSql(): Promise<string> {
  const sql = await readFile(new URL('./roles-s3b.sql', import.meta.url), 'utf8');
  if (createHash('sha256').update(sql).digest('hex') !== S3B_ROLES_SQL_SHA256) throw new Error('tests/support/roles-s3b.sql changed');
  return sql;
}
/** The accepted S3-C text (four roles, no PowerOffice roles/grants), for upgrades from the accepted Stage 3 deployment. */
export async function readS3cRolesSql(): Promise<string> {
  const sql = await readFile(new URL('./poweroffice-roles-s3c.sql', import.meta.url), 'utf8');
  if (createHash('sha256').update(sql).digest('hex') !== S3C_ROLES_SQL_SHA256) throw new Error('tests/support/poweroffice-roles-s3c.sql changed');
  return sql;
}
/** The accepted pre-remote text (six roles), for populated upgrades to ASK-REMOTE R-A; refuses a changed fixture. */
export async function readS5AskbRolesSql(): Promise<string> {
  const sql = await readFile(new URL('./roles-s5askb.sql', import.meta.url), 'utf8');
  if (createHash('sha256').update(sql).digest('hex') !== S5ASKB_ROLES_SQL_SHA256) throw new Error('tests/support/roles-s5askb.sql changed');
  return sql;
}
/** The accepted Stage 2 text, for owner-upgrade tests from a Stage 2 deployment; refuses a changed fixture. */
export async function readStage2RolesSql(): Promise<string> {
  const sql = await readFile(new URL('./roles-stage2.sql', import.meta.url), 'utf8');
  if (createHash('sha256').update(sql).digest('hex') !== STAGE2_ROLES_SQL_SHA256) throw new Error('tests/support/roles-stage2.sql changed');
  return sql;
}

/** Unique, non-prefix-colliding names for one database: atlas_{app,def,run,fen,pod,por,rem}_<label>_<suffix>. */
export function uniqueRoleNames(label: string, suffix: string): RoleNames {
  return { runtime: `atlas_app_${label}_${suffix}`, definer: `atlas_def_${label}_${suffix}`, runner: `atlas_run_${label}_${suffix}`,
    fence: `atlas_fen_${label}_${suffix}`, poDefiner: `atlas_pod_${label}_${suffix}`, poRunner: `atlas_por_${label}_${suffix}`,
    remote: `atlas_rem_${label}_${suffix}`, revalDefiner: `atlas_rvd_${label}_${suffix}`, revalReader: `atlas_rvr_${label}_${suffix}` };
}
/** The R-EVAL roles of these names: explicit, else atlas_app_<x> → atlas_rvd_<x> / atlas_rvr_<x>. */
export function revalRoleNames(names: Pick<RoleNames, 'runtime' | 'revalDefiner' | 'revalReader'>): { definer: string; reader: string } {
  const derived = (prefix: string) => {
    if (!names.runtime.startsWith('atlas_app_')) throw new Error('cannot derive the R-EVAL role names from the runtime name');
    return `${prefix}${names.runtime.slice('atlas_app_'.length)}`;
  };
  return { definer: names.revalDefiner ?? derived('atlas_rvd_'), reader: names.revalReader ?? derived('atlas_rvr_') };
}
const nameFor = (key: keyof RoleNames, names: Partial<RoleNames>): string | undefined =>
  key === 'remote' ? remoteRoleName({ runtime: names.runtime ?? '', remote: names.remote })
  : key === 'revalDefiner' ? revalRoleNames({ runtime: names.runtime ?? '', revalDefiner: names.revalDefiner, revalReader: names.revalReader }).definer
  : key === 'revalReader' ? revalRoleNames({ runtime: names.runtime ?? '', revalDefiner: names.revalDefiner, revalReader: names.revalReader }).reader
  : names[key];
/** The remote definer of these names: explicit, else atlas_app_<x> → atlas_rem_<x> (the same name uniqueRoleNames gives). */
export function remoteRoleName(names: Pick<RoleNames, 'runtime' | 'remote'>): string {
  if (names.remote !== undefined) return names.remote;
  if (!names.runtime.startsWith('atlas_app_')) throw new Error('cannot derive the remote role name from the runtime name');
  return `atlas_rem_${names.runtime.slice('atlas_app_'.length)}`;
}

function render(sql: string, keys: readonly (keyof RoleNames)[], names: Partial<RoleNames>, secrets: RoleSecrets,
  passwords: readonly (keyof RoleSecrets)[] = ['runtimePassword', 'runnerPassword']): string {
  let out = sql;
  for (const key of keys) {
    const [setting, defaultName] = ROLE_SETTINGS[key];
    const token = `set_config('${setting}', '${defaultName}', true)`;
    if (out.split(token).length !== 2) throw new Error('prisma/roles.sql changed shape; update renderRolesSql');
    const name = nameFor(key, names);
    if (name === undefined || !ROLE_NAME.test(name)) throw new Error(`invalid test role name for ${key}`);
    out = out.replace(token, `set_config('${setting}', '${name}', true)`);
  }
  for (const key of Object.keys(PASSWORD_VARIABLES) as (keyof RoleSecrets)[]) {
    const variable = PASSWORD_VARIABLES[key];
    if (out.split(variable).length !== (passwords.includes(key) ? 2 : 1)) throw new Error('prisma/roles.sql changed shape; update renderRolesSql');
    if (!passwords.includes(key)) continue;
    const secret = secrets[key] ?? randomBytes(18).toString('hex');
    if (!SECRET.test(secret)) throw new Error(`invalid test secret for ${key}`);
    out = out.replace(variable, `'${secret}'`);
  }
  const rendered = keys.map(k => nameFor(k, names));
  if (new Set(rendered).size !== keys.length) throw new Error('role names must differ');
  return out;
}
/** The current roles.sql (include inlined): exactly the nine role settings and the four password variables, nine distinct names. */
export function renderRolesSql(sql: string, names: RoleNames, secrets: RoleSecrets): string {
  return render(sql, Object.keys(ROLE_SETTINGS) as (keyof RoleNames)[], names, secrets, Object.keys(PASSWORD_VARIABLES) as (keyof RoleSecrets)[]);
}
/** The accepted pre-remote text (S4-C … S5ASKB-rc2): its six role settings and three password variables, no remote role. */
export function renderS5AskbRolesSql(sql: string, names: RoleNames, secrets: RoleSecrets): string {
  if (sql.includes(`'${ROLE_SETTINGS.remote[0]}'`)) throw new Error('not the accepted pre-remote roles.sql shape');
  return render(sql, S5ASKB_KEYS, names, secrets, PRE_RSA_PASSWORDS);
}
/** The accepted pre-RS-A text (R-A … R-C): its seven role settings and three password variables, no R-EVAL role. */
export function renderS5RemoteRolesSql(sql: string, names: RoleNames, secrets: RoleSecrets): string {
  if (sql.includes(`'${ROLE_SETTINGS.revalDefiner[0]}'`) || sql.includes('\\ir')) throw new Error('not the accepted pre-RS-A roles.sql shape');
  return render(sql, S5REMOTE_KEYS, names, secrets, PRE_RSA_PASSWORDS);
}
/** The accepted Stage 3 texts (S3-A/S3-B/S3-C): exactly their four role settings and two password variables, no PowerOffice role. */
export function renderStage3RolesSql(sql: string, names: Stage3RoleNames, secrets: RoleSecrets): string {
  if (sql.includes(`'${ROLE_SETTINGS.poDefiner[0]}'`)) throw new Error('not a Stage 3 roles.sql shape');
  return render(sql, STAGE3_KEYS, names, secrets);
}
/** The accepted Stage 2 text: exactly its three role settings (no fence setting) and the two password variables. */
export function renderStage2RolesSql(sql: string, names: Stage2RoleNames, secrets: RoleSecrets): string {
  if (sql.includes(`'${ROLE_SETTINGS.fence[0]}'`)) throw new Error('not the Stage 2 roles.sql shape');
  return render(sql, ['runtime', 'definer', 'runner'], names, secrets);
}

/** DROP ROLE statements for teardown, after the database is gone (a dropped database releases the routines' owners). */
export const dropRolesSql = (names: RoleNames): string[] =>
  [revalRoleNames(names).reader, revalRoleNames(names).definer, names.poRunner, names.poDefiner, remoteRoleName(names), names.runner, names.definer,
    names.fence, names.runtime].map(n => `DROP ROLE IF EXISTS "${n}"`);
