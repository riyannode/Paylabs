/**
 * Minimal Resend email wrapper.
 * Only used for OTP delivery — no templates, no fancy HTML.
 */

import { Resend } from "resend";

const ENV_KEY = "RESEND_API_KEY";
const FROM_ADDRESS = "PayLabs <onboarding@resend.dev>";

function getApiKey(): string {
  const key = process.env[ENV_KEY];
  if (!key) throw new Error("RESEND_API_KEY not configured");
  return key;
}

/** Send an OTP code via email. */
export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const client = new Resend(getApiKey());
  const { error } = await client.emails.send({
    from: FROM_ADDRESS,
    to: email,
    subject: "Your PayLabs verification code",
    text: `Your PayLabs code: ${code}\n\nValid for 5 minutes. Do not share this code.`,
  });
  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }
}
