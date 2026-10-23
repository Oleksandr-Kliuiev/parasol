import { Badge, Checkbox, Field, Input, Select, Text, makeStyles } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { AppLink } from '../../shared/components/AppLink';
import { systemName } from '../integrations/labels';
import { choiceValid, emailValid, euRegions, keyValid, type CreateChoice, type CustomerService } from './connectServices';

const useStyles = makeStyles({
  list: { listStyleType: 'none', margin: 0, padding: 0, display: 'grid', gap: '0' },
  item: {
    display: 'grid',
    gap: '8px',
    paddingTop: '14px',
    paddingBottom: '14px',
    borderTop: `1px solid ${h.line}`,
    ':first-child': { borderTop: 'none', paddingTop: '4px' },
  },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '8px', rowGap: '4px' },
  name: { margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 600 },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  fields: { display: 'grid', gap: '12px', paddingLeft: '32px', '@media (max-width: 480px)': { paddingLeft: 0 } },
  link: { display: 'inline-flex', alignItems: 'center', minHeight: '24px' },
});

/** The mapping screen's list of a vendor's customers, where an existing record is linked by hand. */
const mappingsOf: Record<string, string> = {
  atera: '/admin/mappings?system=atera&type=Customer',
  huntress: '/admin/mappings?system=huntress&type=Organization',
  cloudally: '/admin/mappings?system=cloudally&type=Customer',
};

/**
 * The first step of the "Connect services" wizard (M43): one entry per vendor. A linked one says what it is linked to; one that
 * cannot be created here says why, in words of this installation (switched off, not switched on, test customers only), and leads to
 * the mapping screen; the others offer to be created, with the fields their creation takes.
 */
export function ServiceChoices({ services, choices, touched, onChange }: {
  services: CustomerService[];
  choices: CreateChoice[];
  touched: boolean;
  onChange: (choice: CreateChoice) => void;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  return (
    <ul className={styles.list}>
      {services.map((service) => {
        const system = systemName(t, service.system);
        const choice = choices.find((c) => c.system === service.system)!;
        const headingId = `connect-${service.system}`;
        return (
          <li key={service.system} className={styles.item} aria-labelledby={headingId}>
            <div className={styles.head}>
              <h3 id={headingId} className={styles.name}>{system}</h3>
              {service.link && <Badge appearance="tint" color="success">{t('onboarding.linkedBadge')}</Badge>}
            </div>
            {service.link ? (
              <Text className={styles.muted}>{t('onboarding.linked', { name: service.link.name })}</Text>
            ) : service.block ? (
              <>
                <Text className={styles.muted}>{t(`onboarding.blocks.${service.block}`, { system, defaultValue: t(`actions.codes.${service.block}`) })}</Text>
                {mappingsOf[service.system] && (
                  <AppLink to={mappingsOf[service.system]!} className={styles.link}>{t('onboarding.mapExisting')}</AppLink>
                )}
              </>
            ) : (
              <CreateFields service={service} choice={choice} touched={touched} onChange={onChange} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CreateFields({ service, choice, touched, onChange }: {
  service: CustomerService; choice: CreateChoice; touched: boolean; onChange: (choice: CreateChoice) => void;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const system = systemName(t, service.system);
  const showErrors = touched && choice.create && !choiceValid(choice);
  return (
    <>
      <Checkbox checked={choice.create} label={t('onboarding.create', { system })}
        onChange={(_, d) => onChange({ ...choice, create: d.checked === true })} />
      {choice.create && (
        <div className={styles.fields}>
          {service.system === 'atera' && <Text className={styles.muted}>{t('onboarding.atera.note')}</Text>}
          {service.system === 'huntress' && (
            <Field label={t('onboarding.huntress.key')} required hint={t('onboarding.huntress.keyHint')}
              validationMessage={showErrors && !keyValid(choice.key) ? t('onboarding.huntress.keyInvalid') : undefined}>
              <Input value={choice.key} autoComplete="off" spellCheck={false} maxLength={64}
                onChange={(_, d) => onChange({ ...choice, key: d.value.toLowerCase() })} />
            </Field>
          )}
          {service.system === 'cloudally' && (
            <>
              <Field label={t('onboarding.cloudally.email')} required hint={t('onboarding.cloudally.emailHint')}
                validationMessage={showErrors && !emailValid(choice.email) ? t('onboarding.cloudally.emailInvalid') : undefined}>
                <Input type="email" value={choice.email} autoComplete="off" onChange={(_, d) => onChange({ ...choice, email: d.value })} />
              </Field>
              <Field label={t('onboarding.cloudally.region')}>
                <Select value={choice.region} onChange={(_, d) => onChange({ ...choice, region: d.value })}>
                  {euRegions.map((region) => <option key={region} value={region}>{t(`onboarding.regions.${region}`)}</option>)}
                </Select>
              </Field>
            </>
          )}
          {service.simulated && <Text className={styles.muted}>{t('onboarding.simulated', { system })}</Text>}
        </div>
      )}
    </>
  );
}
