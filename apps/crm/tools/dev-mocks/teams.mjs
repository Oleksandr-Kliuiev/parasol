// Teams channel stand-in for external-apis.mjs (M43): the Power Automate "When a Teams webhook request is received" flow that
// Integrations:MicrosoftGraph:Teams:Channels:<channel> points to. `POST /teams/{channel}` takes the message the CRM's sender posts
// ({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content }] }) and answers 202, as a
// Workflows webhook does; a body that is not such a message answers 400. Nothing is forwarded anywhere: the cards stay in memory for a
// test or a demo to read back through the control routes under /_mock/teams (README). Synthetic data only; new on every start.

export function createTeams({ send }) {
  const posts = [];

  /** The card's title, text and facts in a flat form, so a test reads what a person would see in the channel. */
  const flatten = (content) => {
    const blocks = Array.isArray(content?.body) ? content.body : [];
    const texts = blocks.filter((b) => b?.type === 'TextBlock').map((b) => String(b.text ?? ''));
    const facts = blocks.filter((b) => b?.type === 'FactSet').flatMap((b) => (Array.isArray(b.facts) ? b.facts : []))
      .map((f) => ({ title: String(f?.title ?? ''), value: String(f?.value ?? '') }));
    const action = (Array.isArray(content?.actions) ? content.actions : []).find((a) => a?.type === 'Action.OpenUrl');
    return { title: texts[0] ?? '', text: texts[1] ?? '', facts, link: action?.url ?? null, linkText: action?.title ?? null };
  };

  function api(req, res, channel, body) {
    if (req.method !== 'POST') return send(res, 405, { error: 'Only POST' });
    let message;
    try {
      message = JSON.parse(body || 'null');
    } catch {
      return send(res, 400, { error: 'The body must be JSON' });
    }
    const card = message?.type === 'message' && Array.isArray(message.attachments)
      ? message.attachments.find((a) => a?.contentType === 'application/vnd.microsoft.card.adaptive')?.content
      : null;
    if (!card || card.type !== 'AdaptiveCard') return send(res, 400, { error: 'Expected a message with an adaptive card' });
    posts.push({ channel, at: new Date().toISOString(), ...flatten(card) });
    return send(res, 202);
  }

  function control(req, res, url, path) {
    if (req.method === 'GET' && path === 'posts') {
      const channel = url.searchParams.get('channel');
      return send(res, 200, posts.filter((p) => !channel || p.channel.toLowerCase() === channel.toLowerCase()));
    }
    if (req.method === 'DELETE' && path === 'posts') {
      posts.length = 0;
      return send(res, 204);
    }
    return send(res, 404, { error: 'Unknown Teams control route' });
  }

  /** Answers a Teams request (true) or leaves it to the caller (false). */
  return function handle(req, res, url, body) {
    if (url.pathname.startsWith('/_mock/teams/')) {
      control(req, res, url, url.pathname.slice('/_mock/teams/'.length).replace(/\/$/, ''));
      return true;
    }
    const channel = /^\/teams\/([A-Za-z]+)\/?$/.exec(url.pathname);
    if (channel) {
      api(req, res, channel[1], body);
      return true;
    }
    return false;
  };
}
