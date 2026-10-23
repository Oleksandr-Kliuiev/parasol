/* Parasol UX demo: connection readiness (saved facts only, never a live check) and the admin hub. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var UI = P.ui$;

  function flag(on, label) {
    return h`<span class="pill ${on ? 'pill-good' : 'pill-outline'}">${P.icon(on ? 'check' : 'minusCircle', 'ic-14')}${label}</span>`;
  }

  function providerCard(id, icon, cfg) {
    var x = D.connections[id];
    return UI.card({ title: t('conn.' + id), icon: icon, titleId: 'cn-' + id,
      body: h`<div class="row-wrap">${flag(x.enabled, x.enabled ? t('conn.enabled') : t('conn.disabled'))}${flag(x.write, x.write ? t('conn.writeOn') : t('conn.writeOff'))}${x.paused ? h`<span class="pill pill-warn">${P.icon('pause', 'ic-14')}${t('conn.paused')}</span>` : ''}</div>
        <dl class="kv"><dt>${t('conn.lastSuccess')}</dt><dd class="num">${P.fmt.when(x.lastSuccess)}</dd>
          <dt>${t('conn.records')}</dt><dd class="num">${P.fmt.num(x.records)}</dd>
          <dt>${t('conn.unlinked')}</dt><dd class="num">${P.fmt.num(x.unlinked)}</dd>
          <dt>${t('conn.outbound')}</dt><dd class="num">${t('conn.outboundText', { pending: x.pending, failed: x.failed })}</dd></dl>
        ${cfg || ''}`,
      foot: h`<span class="row">${P.icon('info', 'ic-14')}${t('conn.notChecked')}</span>` });
  }

  P.views.connections = {
    perm: 'atlas',
    render: function () {
      var c = D.connections;
      var admin = P.can('integrations');
      var body = h`${UI.pageHead({ title: t('nav.connections'), sub: t('conn.sub') })}
        <div class="page-banner">${UI.banner('info', t('conn.bannerTitle'), t('conn.bannerText'), '', 'info')}</div>
        <div class="grid-cards">
          ${UI.card({ title: t('conn.atlas'), icon: 'umbrella', titleId: 'cn-atlas',
            body: h`<div class="row-wrap">${flag(c.atlasPersonal === 'PERSONAL_ENTRY_PRESENT', t('conn.personal.' + c.atlasPersonal))}</div>
              <dl class="kv"><dt>${t('conn.mapping')}</dt><dd>${t('conn.mappingState.' + c.mappings.state)}</dd>
                <dt>${t('conn.mappingChecked')}</dt><dd class="num">${t('conn.mappingCount', { n: c.mappings.checked, limit: c.mappings.limit })}</dd>
                <dt>${t('conn.review')}</dt><dd>${t('conn.reviewState.' + c.mappings.review)}</dd>
                <dt>${t('conn.unlinkedCustomers')}</dt><dd class="num">${P.fmt.num(c.mappings.unlinked)}</dd></dl>`,
            tools: admin ? h`<a class="btn btn-link" href="#/admin">${t('conn.openMapping')}</a>` : '',
            foot: h`<span>${t('conn.mappingFoot')}</span>` })}
          ${admin ? providerCard('atera', 'server', h`<p class="small muted">${t('conn.ateraNote')}</p>`) : ''}
          ${admin ? providerCard('poweroffice', 'files', h`<p class="small muted">${t('conn.poNote')}</p>`) : ''}
          ${UI.card({ title: 'Huntress', icon: 'shield', titleId: 'cn-huntress', body: h`<p>${t('conn.huntress')}</p>`,
            foot: h`<span class="row">${P.icon('info', 'ic-14')}${t('conn.notChecked')}</span>` })}
          ${admin ? UI.card({ title: 'Microsoft Graph', icon: 'cloud', titleId: 'cn-graph',
            body: h`<div class="row-wrap">${flag(c.graph.calendar, t('conn.calendar'))}${flag(c.graph.mail, t('conn.mail'))}${flag(c.graph.sharepoint, 'SharePoint')}${flag(c.graph.teams, 'Teams')}</div>
              <dl class="kv"><dt>${t('conn.directorySync')}</dt><dd class="num">${P.fmt.when(c.graph.directorySync)}</dd><dt>${t('conn.roleSync')}</dt><dd class="num">${P.fmt.when(c.graph.roleSync)}</dd>
                <dt>${t('conn.auth')}</dt><dd>${c.authMode === 'ENTRA' ? 'Microsoft Entra ID' : t('conn.devAuth')}</dd></dl>`,
            foot: h`<span class="row">${P.icon('info', 'ic-14')}${t('conn.notChecked')}</span>` }) : ''}
        </div>
        ${admin ? '' : h`<p class="footnote">${P.icon('lock', 'ic-14')}${t('conn.adminOnly')}</p>`}`;
      return { title: t('nav.connections'), crumbs: [{ label: 'Parasol', href: '#/day' }, { label: t('nav.connections') }], body: body };
    }
  };

  /* Grouped by what the admin is trying to do; each card names the route of the existing CRM page it stands for */
  var ADMIN = [
    ['groupPeople', [['users', 'users', '/admin/users'], ['technicians', 'user', '/admin/technicians'], ['recordAccess', 'lock', '/admin/record-access'], ['privacy', 'shieldCheck', '/admin/privacy']]],
    ['groupData', [['integrations', 'plug', '/admin/integrations'], ['atlasMapping', 'link', '/admin/mappings/atlas'], ['mappings', 'compare', '/admin/mappings'], ['migration', 'download', '/admin/migration']]],
    ['groupCatalog', [['catalog', 'contract', '/catalog'], ['quoteTemplates', 'files', '/admin/quote-templates'], ['pipelineStages', 'kanban', '/admin/pipeline'], ['customFields', 'sliders', '/admin/custom-fields']]],
    ['groupOps', [['audit', 'history', '/admin/audit'], ['maintenance', 'pause', '/admin/maintenance']]]
  ];

  P.views.admin = {
    perm: 'admin',
    render: function () {
      var body = h`${UI.pageHead({ title: t('nav.admin'), sub: t('admin.sub') })}
        <div class="stack-4">${ADMIN.map(function (g) {
          return h`<section class="admin-group" aria-labelledby="ag-${g[0]}"><h2 class="eyebrow" id="ag-${g[0]}">${t('admin.' + g[0])}</h2>
            <div class="admin-grid">${g[1].map(function (a) {
              return h`<button class="card admin-card" type="button" data-action="admin-open" data-value="${a[2]}"><span class="kpi-icon">${P.icon(a[1])}</span>
                <span class="admin-text"><strong>${t('admin.' + a[0])}</strong><span class="small muted">${t('admin.' + a[0] + 'Text')}</span></span>${P.icon('chevronRight', 'ic-16 muted')}</button>`;
            })}</div></section>`;
        })}</div>
        <p class="footnote">${P.icon('info', 'ic-14')}${t('admin.foot')}</p>`;
      return { title: t('nav.admin'), crumbs: [{ label: 'Parasol', href: '#/day' }, { label: t('nav.admin') }], body: body };
    }
  };
  P.on('admin-open', function (el) { P.toast(t('admin.notInDemo', { route: el.dataset.value }), { tone: 'warn' }); });
})();
