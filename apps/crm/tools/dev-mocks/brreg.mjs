// Enhetsregisteret (Brønnøysund) stand-in for external-apis.mjs: /enhetsregisteret/api/enheter/{orgnr} and the name search.
// Two fixed companies (one bankrupt); any other valid number starting with 8 exists as a generated company, so tests can
// create organizations with numbers of their own.

function enhet(nr, name, extra = {}) {
  return {
    organisasjonsnummer: nr, navn: name, organisasjonsform: { kode: 'AS', beskrivelse: 'Aksjeselskap' },
    naeringskode1: { kode: '62.020', beskrivelse: 'Konsulentvirksomhet tilknyttet informasjonsteknologi' },
    forretningsadresse: { adresse: ['Storgata 1'], postnummer: '0155', poststed: 'OSLO', landkode: 'NO' },
    postadresse: { adresse: ['Postboks 1'], postnummer: '0101', poststed: 'OSLO', landkode: 'NO' },
    hjemmeside: `www.${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.no`, konkurs: false, underAvvikling: false, underTvangsavviklingEllerTvangsopplosning: false,
    ...extra,
  };
}

const validOrgNumber = (nr) => {
  if (!/^\d{9}$/.test(nr)) return false;
  const w = [3, 2, 7, 6, 5, 4, 3, 2];
  let c = 11 - ([...nr.slice(0, 8)].reduce((s, d, i) => s + Number(d) * w[i], 0) % 11);
  if (c === 11) c = 0;
  return c !== 10 && c === Number(nr[8]);
};

export function createBrreg({ send }) {
  const registry = new Map([
    ['923609016', enhet('923609016', 'EQUINOR ASA', { organisasjonsform: { kode: 'ASA', beskrivelse: 'Allmennaksjeselskap' } })],
    ['912345675', enhet('912345675', 'NORDLYS DRIFT AS', { konkurs: true })],
  ]);

  /** Answers a registry request (true) or leaves it to the caller (false). */
  return function handle(req, res, url) {
    const enhetMatch = url.pathname.match(/^\/enhetsregisteret\/api\/enheter\/(\d+)$/);
    if (enhetMatch) {
      const nr = enhetMatch[1];
      if (registry.has(nr)) send(res, 200, registry.get(nr));
      else if (validOrgNumber(nr) && nr.startsWith('8')) send(res, 200, enhet(nr, `TESTFIRMA ${nr} AS`));
      else send(res, 404, { feilmelding: 'Ikke funnet' });
      return true;
    }
    if (url.pathname === '/enhetsregisteret/api/enheter') {
      const name = (url.searchParams.get('navn') ?? '').toLowerCase();
      const found = [...registry.values()].filter((e) => e.navn.toLowerCase().includes(name));
      send(res, 200, found.length ? { _embedded: { enheter: found }, page: { totalElements: found.length } } : { page: { totalElements: 0 } });
      return true;
    }
    return false;
  };
}
