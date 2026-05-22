interface ApplicationStatusTemplateOptions {
  applicantName: string;
  jobTitle: string;
  companyName: string;
}

export const applicationStatusTemplate = ({
  applicantName,
  jobTitle,
  companyName,
}: ApplicationStatusTemplateOptions): string => {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Application Status Update</title>
</head>

<body style="
  margin: 0;
  padding: 0;
  background-color: #f1f5f9;
  font-family: Arial, Helvetica, sans-serif;
">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="
          background-color: #ffffff;
          border-radius: 20px;
          overflow: hidden;
          box-shadow: 0 8px 24px rgba(0,0,0,0.08);
        ">

          <!-- Top Banner -->
          <tr>
            <td style="
              background: linear-gradient(135deg, #3b82f6, #8b5cf6);
              padding: 40px 30px;
              text-align: center;
            ">
              <div style="
                width: 70px;
                height: 70px;
                line-height: 70px;
                margin: 0 auto 20px;
                background-color: rgba(255,255,255,0.15);
                border-radius: 50%;
                font-size: 32px;
              ">
                🔔
              </div>
              <h1 style="margin: 0; color: #ffffff; font-size: 30px; font-weight: bold;">
                Application Status Update
              </h1>
              <p style="margin-top: 12px; color: rgba(255,255,255,0.9); font-size: 16px;">
                ${companyName} has updated your application
              </p>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 40px 35px;">
              <p style="margin-top: 0; font-size: 16px; color: #0f172a; line-height: 1.7;">
                Hi <strong>${applicantName}</strong>,
              </p>

              <p style="font-size: 16px; color: #475569; line-height: 1.8;">
                Your application for the position of
                <strong>${jobTitle}</strong> at <strong>${companyName}</strong>
                has been updated.
              </p>

              <div style="
                margin: 30px 0;
                padding: 24px;
                background-color: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 14px;
                text-align: center;
              ">
                <p style="margin: 0; color: #64748b; font-size: 15px; line-height: 1.8;">
                  Please log in to <strong style="color: #3b82f6;">HireHeaven</strong> to view your updated application status.
                </p>
              </div>

              <p style="margin-top: 35px; font-size: 15px; color: #0f172a; line-height: 1.7;">
                Best regards,<br/>
                <strong>${companyName} Recruitment Team</strong>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="
              background-color: #f8fafc;
              padding: 20px;
              text-align: center;
              color: #94a3b8;
              font-size: 13px;
            ">
              <p style="margin: 0;">© ${new Date().getFullYear()} ${companyName}. All rights reserved.</p>
              <p style="margin: 4px 0 0;">This is an automated message, please do not reply.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
};
