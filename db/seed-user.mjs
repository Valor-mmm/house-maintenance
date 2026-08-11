#!/usr/bin/env node
// Creates the single v1 user and makes them 'owner' of the seeded property
// (see db/migrations/006_seed.sql). Run once, locally, against your Neon
// database — never commit real credentials.
//
//   HOUSE_USERNAME=... HOUSE_PASSWORD=... node --env-file=.env db/seed-user.mjs
import pg from "pg";
import { hashPassword } from "@house/server-lib";

const PROPERTY_ID = "00000000-0000-0000-0000-000000000001";

const databaseUrl = process.env.DATABASE_URL;
const username = process.env.HOUSE_USERNAME;
const password = process.env.HOUSE_PASSWORD;

if (!databaseUrl || !username || !password) {
  console.error(
    "DATABASE_URL, HOUSE_USERNAME and HOUSE_PASSWORD must all be set."
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });

async function main() {
  await client.connect();
  const passwordHash = await hashPassword(password);

  const { rows } = await client.query(
    `insert into users (username, password_hash)
     values ($1, $2)
     on conflict (username) do update set password_hash = excluded.password_hash
     returning id`,
    [username, passwordHash]
  );
  const userId = rows[0].id;

  await client.query(
    `insert into property_members (user_id, property_id, role)
     values ($1, $2, 'owner')
     on conflict (user_id, property_id) do nothing`,
    [userId, PROPERTY_ID]
  );

  console.log(`User '${username}' (${userId}) is now owner of ${PROPERTY_ID}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => client.end());
