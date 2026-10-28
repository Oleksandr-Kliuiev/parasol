import type { TFunction } from 'i18next';
import type { SearchHit } from '../api/types';
import { serviceName } from '../features/backup/backupText';
import { alertTitle, sourceName } from '../features/service/alerts/alertText';
import { formatDate } from '../shared/utils/format';

/** A state a hit carries beside its title: an alert's severity, a ticket's status, a device no longer reported. */
export interface HitBadge {
  text: string;
  color: 'danger' | 'warning' | 'informative' | 'subtle';
}

/** A hit as the palette shows it, in the reader's language. */
export interface HitWords {
  title: string;
  subtitle: string | null;
  badge?: HitBadge;
}

/** The permission each group of the search needs, as the server checks it: the groups a person's search looks in. */
export const searchGroupPermissions: Record<string, string> = {
  organizations: 'customers.read',
  contacts: 'customers.read',
  devices: 'service.read',
  alerts: 'service.read',
  tickets: 'service.read',
  backup: 'service.read',
  products: 'catalog.read',
};

/** The groups of a customer's records: a word of the customer's name narrows them, and their note about more hits says so. */
export const customerGroups = new Set(['devices', 'alerts', 'tickets', 'backup']);

const join = (...parts: Array<string | null | undefined | false>) => parts.filter((part) => part).join(' · ') || null;

/**
 * What a hit says. A customer's records (operations groups) carry facts the server leaves to the interface: the device's type and
 * where a word was found (serial number, a user logged in, another name of the machine), an alert's severity, source and Parasoll's
 * own wording of a gap, a ticket's status, the services a person is backed up in. Other groups say what the server wrote.
 */
export function hitWords(t: TFunction, group: string, hit: SearchHit): HitWords {
  const facts = hit.facts ?? {};
  switch (group) {
    case 'devices': {
      // The two users the machine's card names apart: logged in at the source's read, and the last one to log in.
      const found = facts.serial ? t('search.matched.serial', { value: facts.serial })
        : facts.loggedIn ? t('search.matched.loggedIn', { value: facts.loggedIn })
          : facts.lastLogin ? t('search.matched.lastLogin', { value: facts.lastLogin })
            : facts.alias ? t('search.matched.alias', { value: facts.alias })
              : facts.os;
      return {
        title: hit.title,
        subtitle: join(hit.subtitle, facts.type && t(`service.deviceType.${facts.type}`, { defaultValue: facts.type }), found),
        badge: facts.removedAt ? { text: t('machines.removed'), color: 'subtle' } : undefined,
      };
    }
    case 'alerts':
      return {
        title: alertTitle(t, { title: hit.title, rule: facts.rule ?? null, facts }),
        subtitle: join(hit.subtitle, facts.device, facts.system && t('alerts.source', { name: sourceName(t, facts.system) }),
          facts.hiddenUntil && t('alerts.hide.untilFact', { date: formatDate(facts.hiddenUntil) })),
        badge: facts.severity
          ? { text: t(`service.severities.${facts.severity}`, { defaultValue: facts.severity }), color: facts.severity === 'Critical' ? 'danger' : 'warning' }
          : undefined,
      };
    case 'tickets':
      return {
        title: hit.title,
        subtitle: hit.subtitle,
        badge: facts.status
          ? { text: t(`tickets.statuses.${facts.status}`, { defaultValue: facts.status }), color: facts.open === 'false' ? 'subtle' : 'informative' }
          : undefined,
      };
    case 'backup':
      return {
        title: hit.title,
        // The customer first, as in every group; a person's address says which of several namesakes it is.
        subtitle: join(hit.subtitle, facts.services && facts.services.split(',').map((service) => serviceName(t, service)).join(', '), facts.address),
      };
    default:
      return { title: hit.title, subtitle: hit.subtitle };
  }
}
