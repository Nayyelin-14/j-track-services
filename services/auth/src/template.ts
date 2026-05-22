// ─── utils/emailTemplates/resetPasswordEmailTemplate.ts ───────────────────

interface ResetPasswordEmailTemplateOptions {
  name: string;
  resetLink: string;
  expiresInMinutes?: number;
}

export const resetPasswordEmailTemplate = ({
  name,
  resetLink,
  expiresInMinutes = 15,
}: ResetPasswordEmailTemplateOptions): string => {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Reset Your Password</title>
</head>
<body style="
  margin: 0;
  padding: 0;
  background-color: #f4f4f7;
  font-family: 'Segoe UI', Arial, sans-serif;
">

  <!-- Wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7; padding: 40px 0;">
    <tr>
      <td align="center">

        <!-- Card -->
        <table width="600" cellpadding="0" cellspacing="0" style="
          max-width: 600px;
          width: 100%;
          background-color: #ffffff;
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 4px 24px rgba(0,0,0,0.08);
        ">

          <!-- Header -->
          <tr>
            <td style="
              background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
              padding: 40px 48px;
              text-align: center;
            ">
              <div style="
                width: 64px;
                height: 64px;
                background: rgba(255,255,255,0.15);
                border-radius: 50%;
                margin: 0 auto 16px;
                line-height: 64px;
                font-size: 28px;
                text-align: center;
              ">🔐</div>

              <h1 style="
                margin: 0;
                color: #ffffff;
                font-size: 26px;
                font-weight: 700;
                letter-spacing: -0.5px;
              ">Reset Your Password</h1>

              <p style="
                margin: 8px 0 0;
                color: rgba(255,255,255,0.75);
                font-size: 14px;
              ">We received a request to reset your password</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 40px 48px;">

              <p style="
                margin: 0 0 8px;
                color: #374151;
                font-size: 16px;
              ">Hi <strong>${name}</strong>,</p>

              <p style="
                margin: 0 0 28px;
                color: #6B7280;
                font-size: 15px;
                line-height: 1.6;
              ">
                Someone requested a password reset for your account.
                If this was you, click the button below to set a new password.
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom: 28px;">
                    <a href="${resetLink}" style="
                      display: inline-block;
                      background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
                      color: #ffffff;
                      text-decoration: none;
                      font-size: 15px;
                      font-weight: 600;
                      padding: 14px 40px;
                      border-radius: 8px;
                      letter-spacing: 0.3px;
                    ">Reset Password →</a>
                  </td>
                </tr>
              </table>

              <!-- Divider -->
              <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 0 0 24px;" />

              <!-- Expiry Notice -->
              <table width="100%" cellpadding="0" cellspacing="0" style="
                background-color: #FEF3C7;
                border-radius: 8px;
                margin-bottom: 24px;
              ">
                <tr>
                  <td style="padding: 14px 18px;">
                    <p style="
                      margin: 0;
                      color: #92400E;
                      font-size: 13px;
                      line-height: 1.5;
                    ">
                      ⏱️ <strong>This link expires in ${expiresInMinutes} minutes.</strong>
                      After that, you'll need to request a new one.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Fallback Link -->
              <p style="
                margin: 0 0 8px;
                color: #6B7280;
                font-size: 13px;
              ">Button not working? Copy and paste this link into your browser:</p>
              <p style="
                margin: 0 0 28px;
                word-break: break-all;
                font-size: 12px;
                color: #4F46E5;
              ">${resetLink}</p>

              <!-- Divider -->
              <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 0 0 24px;" />

              <!-- Security Notice -->
              <table width="100%" cellpadding="0" cellspacing="0" style="
                background-color: #F9FAFB;
                border-radius: 8px;
                border-left: 4px solid #E5E7EB;
              ">
                <tr>
                  <td style="padding: 14px 18px;">
                    <p style="
                      margin: 0;
                      color: #6B7280;
                      font-size: 13px;
                      line-height: 1.5;
                    ">
                      🛡️ If you didn't request a password reset, you can safely ignore this email.
                      Your password will remain unchanged.
                    </p>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="
              background-color: #F9FAFB;
              padding: 24px 48px;
              text-align: center;
              border-top: 1px solid #E5E7EB;
            ">
              <p style="
                margin: 0 0 4px;
                color: #9CA3AF;
                font-size: 12px;
              ">This email was sent by <strong style="color:#4F46E5;">YourApp</strong></p>
              <p style="
                margin: 0;
                color: #D1D5DB;
                font-size: 11px;
              ">Do not share this link with anyone · © ${new Date().getFullYear()} YourApp</p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>
  `.trim();
};
