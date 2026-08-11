-- Seed the single v1 property with a fixed, known id so app config can
-- reference it directly. User creation (involves password hashing) is
-- handled separately by `node db/seed-user.mjs` — see that script.

insert into properties (id, name, type)
values ('00000000-0000-0000-0000-000000000001', 'My House', 'primary_residence')
on conflict (id) do nothing;
