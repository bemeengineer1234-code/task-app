// Serverless function to complete Slack OAuth exchange and redirect back to the app with the Slack user's email
// Requires environment variables: VITE_SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, VITE_SLACK_REDIRECT_URI, APP_URL

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const code = url.searchParams.get('code');
    if (!code) return res.status(400).send('Missing code');

    const client_id = process.env.VITE_SLACK_CLIENT_ID || process.env.SLACK_CLIENT_ID;
    const client_secret = process.env.SLACK_CLIENT_SECRET;
    const redirect_uri = process.env.VITE_SLACK_REDIRECT_URI;

    if (!client_id || !client_secret) {
      return res.status(500).send('Slack client_id or client_secret is not configured');
    }

    const params = new URLSearchParams();
    params.append('client_id', client_id);
    params.append('client_secret', client_secret);
    params.append('code', code);
    if (redirect_uri) params.append('redirect_uri', redirect_uri);

    const tokenResp = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      body: params
    });
    const tokenJson = await tokenResp.json();
    if (!tokenJson.ok) {
      return res.status(500).send('Slack exchange failed: ' + JSON.stringify(tokenJson));
    }

    const accessToken = tokenJson.authed_user?.access_token || tokenJson.access_token;
    const userId = tokenJson.authed_user?.id || tokenJson.authed_user?.user_id || tokenJson.authed_user?.user?.id || tokenJson.authed_user;
    let email = '';

    if (accessToken && userId) {
      try {
        const infoResp = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const infoJson = await infoResp.json();
        if (infoJson.ok && infoJson.user?.profile?.email) {
          email = infoJson.user.profile.email;
        }
      } catch (error) {
        console.error('Slack user info failed', error);
      }
    }

    const baseUrl = process.env.APP_URL || (redirect_uri || '');
    const sanitizedBase = baseUrl.replace(/\/?$/, '');
    const query = new URLSearchParams();
    if (email) query.append('slack_email', email);
    if (userId) query.append('slack_uid', userId);
    const redirectUrl = `${sanitizedBase}?${query.toString()}`;

    res.writeHead(302, { Location: redirectUrl });
    res.end();
  } catch (error) {
    console.error('Slack callback error', error);
    res.status(500).send('Internal Server Error');
  }
};