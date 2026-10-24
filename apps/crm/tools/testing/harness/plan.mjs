// The pinned SQL Server image and the ownership rules of the one container a harness run creates.
export const SQL_IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest@sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718';
export const CONTAINER_LABEL = 'parasol.harness.run';

export function assertOwnedContainerLabel(state, name, label) {
  if (name !== state.sqlContainer || label !== state.runId
    || !name.startsWith(`parasol-harness-${state.runId}-`)) throw new Error('Refusing a foreign database container.');
}

export function assertOwnedContainerNetwork(state, name, info) {
  assertOwnedContainerLabel(state, name, info?.Config?.Labels?.[CONTAINER_LABEL]);
  const mappings = info.NetworkSettings?.Ports?.['1433/tcp'];
  if (!Array.isArray(mappings) || mappings.length !== 1 || mappings[0].HostIp !== '127.0.0.1'
    || mappings[0].HostPort !== String(state.ports.sql))
    throw new Error('Refusing a database endpoint not bound to its owned container.');
}
