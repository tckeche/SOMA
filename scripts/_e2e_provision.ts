/* Temporary E2E account provisioner. Creates confirmed Supabase auth users
   (tutor + student) so the Playwright run can log in via the UI without the
   email-verification gate. Prints ONLY the emails/passwords it generated (no
   secrets). Run with: npx tsx scripts/_e2e_provision.ts */

const SUPA_URL = process.env.VITE_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPA_URL || !SERVICE_KEY) {
  console.error("Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const stamp = Date.now().toString(36);

async function createUser(role: "tutor" | "student") {
  const email = `e2e_${role}_${stamp}@somatest.dev`;
  const password = `Test!${stamp}${role}A1`;
  const res = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        requested_role: role,
        first_name: "E2E",
        last_name: role === "tutor" ? "Tutor" : "Student",
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`Failed to create ${role}:`, JSON.stringify(data));
    process.exit(1);
  }
  return { role, email, password, id: data.id as string };
}

const tutor = await createUser("tutor");
const student = await createUser("student");

console.log(JSON.stringify({ tutor, student }, null, 2));
