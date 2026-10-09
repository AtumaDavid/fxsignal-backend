/**
 * Admins are listed by email in ADMIN_EMAILS (comma-separated), so access is
 * granted in the server's .env, never from the app.
 */
export function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isAdminEmail(email: string | null | undefined) {
  return Boolean(email) && adminEmails().has(email!.toLowerCase());
}
