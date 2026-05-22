const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { emails, subject, message } = req.body;

    if (!emails || !emails.length) {
      return res.status(400).json({ error: 'No emails provided' });
    }

    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({ error: 'RESEND_API_KEY is not configured' });
    }

    // Since we might not have a verified domain on Resend,
    // we use onboarding@resend.dev as the sender. 
    // Note: this might only work if sending to the verified owner's email.
    const { data, error } = await resend.emails.send({
      from: 'SyncTask Notifications <onboarding@resend.dev>',
      to: emails,
      subject: subject || 'SyncTask Notification',
      html: `
        <div style="font-family: sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #4f46e5;">🚀 SyncTask Notification</h2>
          <p style="font-size: 16px; line-height: 1.5; white-space: pre-wrap;">${message}</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
          <p style="font-size: 12px; color: #999;">This is an automated notification from SyncTask App.</p>
        </div>
      `,
    });

    if (error) {
      console.error('Resend Error:', error);
      return res.status(400).json({ error });
    }

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Email API Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
