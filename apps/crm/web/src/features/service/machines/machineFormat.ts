import type { DeviceDisk, MachineDevice, MachineEvidence } from '../types';
import { formatNumber } from '../../../shared/utils/format';

/**
 * The device whose description the card shows (M40): of the devices still reported, the one in touch most recently; a machine
 * no source reports any more shows its last one.
 */
export function leadDevice(devices: readonly MachineDevice[]): MachineDevice | undefined {
  const current = devices.filter((d) => d.removedAt === null);
  const shown = current.length > 0 ? current : devices;
  return [...shown].sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '') || Number(b.online) - Number(a.online))[0];
}

/** Atera's API gives memory without a unit; its console shows megabytes, as this does. */
export function memoryText(memory: number | null): string | null {
  return memory === null ? null : `${formatNumber(memory, 0)} MB`;
}

/** A disk's free share: a ratio needs no unit, which Atera's API does not give. */
export function freeShare(disk: DeviceDisk): number | null {
  return disk.total && disk.total > 0 && disk.free !== null ? Math.round((disk.free / disk.total) * 100) : null;
}

/** The strongest reason first, the conflict last: "serial number, MAC address" before "the serial numbers differ". */
export const evidenceOrder: readonly MachineEvidence[] = ['serial', 'mac', 'name', 'serialConflict'];
