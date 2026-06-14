---
name: Signup role resolution & anti-escalation
description: How a user's role is decided at signup/auth-sync, and why self-selection is clamped and existing roles are frozen.
---

# Signup role resolution

Role is resolved by `determineRole(email, requestedRole?)` in `server/routes.ts`.
Precedence: super_admin email → `super_admin`; tutor email domain → `tutor`;
else the self-selected `requested_role` (only `tutor`|`student`); else `student`.

The signup form lets the user pick Student or Tutor and sends it as
`user_metadata.requested_role`. Students additionally provide subject/syllabus/level;
tutors provide only first name, surname, email, password.

**Why:** the user explicitly wanted role to come from a selector, not just the email
domain. But Supabase lets a signed-in user edit their own `user_metadata`, so trusting
`requested_role` on every sync would let a student self-promote to tutor.

**How to apply:**
- `requested_role` is honoured ONLY on first-create of a DB row. Both provisioning
  paths must respect this: `/api/auth/sync` uses
  `existingUser ? existingUser.role : determineRole(email, requested_role)`, and
  `/api/auth/me` first-create passes the role from the verified token
  (`verifySupabaseToken` returns `requestedRole`, clamped to tutor|student).
- For an EXISTING user, never recompute role from request/token metadata — keep the
  stored DB role. This is the escalation guard.
- `super_admin` can never be self-assigned; it comes from `SUPER_ADMIN_EMAIL` only.
- If you add another path that auto-creates a `somaUsers` row, it must follow the same
  first-create-only rule or it will silently downgrade tutor signups to student.
