/* Parasoll UX demo: state of the CRM integrations (saved facts only, never a live check) and the admin hub. */
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

  /* One row per sync with the time of its last success; after a failed later attempt that data is outdated, and the row says why */
  function syncRows(x) {
    return h`<ul class="rows sync-list">${x.syncs.map(function (s) {
      return h`<li class="item"><div class="item-main"><span class="item-title">${t('conn.sync.' + s.id)}</span>
          ${s.failedAt ? h`<span class="small crit-text">${t('conn.syncFailed', { time: P.fmt.time(s.failedAt) })}</span>` : ''}</div>
        <div class="item-side">${UI.fresh(s.failedAt ? 'STALE' : 'OK', s.ok)}</div></li>`;
    })}</ul>`;
  }

  function providerCard(id, icon, note) {
    var x = D.connections[id];
    var admin = P.can('integrations');
    return UI.card({ title: t('conn.' + id), icon: icon, titleId: 'cn-' + id,
      tools: admin ? h`<a class="btn btn-link" href="#/admin">${t('nav.admin')}</a>` : '',
      body: h`<div class="row-wrap">${flag(x.enabled, x.enabled ? t('conn.enabled') : t('conn.disabled'))}${x.write == null ? '' : flag(x.write, x.write ? t('conn.writeOn') : t('conn.writeOff'))}${x.paused ? h`<span class="pill pill-warn">${P.icon('pause', 'ic-14')}${t('conn.paused')}</span>` : ''}</div>
        <p class="small strong">${t('conn.lastSuccess')}</p>
        ${syncRows(x)}
        <dl class="kv"><dt>${t('conn.records')}</dt><dd class="num">${P.fmt.num(x.records)}</dd>
          <dt>${t('conn.unlinkedCustomers')}</dt><dd class="num">${P.fmt.num(x.unlinkedCrm)}</dd>
          <dt>${t('conn.unlinked')}</dt><dd class="num">${P.fmt.num(x.unlinked)}</dd>
          ${x.write ? h`<dt>${t('conn.outbound')}</dt><dd class="num">${t('conn.outboundText', { pending: x.pending, failed: x.failed })}</dd>` : ''}</dl>
        ${note ? h`<p class="small muted">${note}</p>` : ''}`,
      foot: h`<span class="row">${P.icon('info', 'ic-14')}${t('conn.notChecked')}</span>` });
  }

  P.views.connections = {
    perm: 'service',
    render: function () {
      var c = D.connections;
      var admin = P.can('integrations');
      var body = h`${UI.pageHead({ title: t('nav.connections'), sub: t('conn.sub') })}
        <div class="page-banner">${UI.banner('info', t('conn.bannerTitle'), t('conn.bannerText'), '', 'info')}</div>
        <div class="grid-cards">
          ${UI.card({ title: t('conn.worker'), icon: 'refresh', titleId: 'cn-worker',
            body: h`<p class="row strong">${P.icon('circleCheck', 'ic-16')}${t('conn.heartbeat', { time: P.fmt.time(c.heartbeat), ago: P.fmt.ago(c.heartbeat) })}</p>
              <p class="small muted">${t('conn.heartbeatNote')}</p>
              <p class="small muted">${t('conn.credsNote')}</p>`,
            foot: h`<span class="row">${P.icon('info', 'ic-14')}${t('conn.notChecked')}</span>` })}
          ${providerCard('atera', 'server', t('conn.ateraNote', { n: D.unmatchedAlerts }))}
          ${providerCard('huntress', 'shield', t('conn.huntressNote'))}
          ${UI.card({ title: t('conn.cloudally'), icon: 'cloud', titleId: 'cn-cloudally',
            body: h`<div class="row-wrap">${UI.fresh('NOT_CONNECTED')}</div><p>${t('conn.cloudallyText')}</p>`,
            foot: h`<span class="row">${P.icon('info', 'ic-14')}${t('conn.notChecked')}</span>` })}
          ${providerCard('poweroffice', 'files', t('conn.poNote'))}
          ${admin ? UI.card({ title: 'Microsoft Graph', icon: 'users', titleId: 'cn-graph',
            body: h`<div class="row-wrap">${flag(c.graph.calendar, t('conn.calendar'))}${flag(c.graph.mail, t('conn.mail'))}${flag(c.graph.sharepoint, 'SharePoint')}${flag(c.graph.teams, 'Teams')}</div>
              <dl class="kv"><dt>${t('conn.directorySync')}</dt><dd class="num">${P.fmt.when(c.graph.directorySync)}</dd><dt>${t('conn.roleSync')}</dt><dd class="num">${P.fmt.when(c.graph.roleSync)}</dd>
                <dt>${t('conn.auth')}</dt><dd>${c.authMode === 'ENTRA' ? 'Microsoft Entra ID' : t('conn.devAuth')}</dd></dl>`,
            foot: h`<span class="row">${P.icon('info', 'ic-14')}${t('conn.notChecked')}</span>` }) : ''}
        </div>
        ${admin ? '' : h`<p class="footnote">${P.icon('lock', 'ic-14')}${t('conn.adminOnly')}</p>`}`;
      return { title: t('nav.connections'), crumbs: [{ label: 'Parasoll', href: '#/day' }, { label: t('nav.connections') }], body: body };
    }
  };

  /* Grouped by what the admin is trying to do; each card names the route of the existing CRM page it stands for */
  var ADMIN = [
    ['groupPeople', [['users', 'users', '/admin/users'], ['technicians', 'user', '/admin/technicians'], ['recordAccess', 'lock', '/admin/record-access'], ['privacy', 'shieldCheck', '/admin/privacy']]],
    ['groupData', [['integrations', 'plug', '/admin/integrations'], ['mappings', 'compare', '/admin/mappings'], ['background', 'timer', '/admin/jobs'], ['migration', 'download', '/admin/migration']]],
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
      return { title: t('nav.admin'), crumbs: [{ label: 'Parasoll', href: '#/day' }, { label: t('nav.admin') }], body: body };
    }
  };
  P.on('admin-open', function (el) { P.toast(t('admin.notInDemo', { route: el.dataset.value }), { tone: 'warn' }); });
})();
