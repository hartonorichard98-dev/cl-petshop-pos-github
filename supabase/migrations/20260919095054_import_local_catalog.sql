alter table public.stores
alter column created_by drop not null;

insert into public.stores (id, name, created_by)
values ('24a3a058-991b-4b64-b1d2-912910842d34', 'CL Petshop', null)
on conflict (id) do update
set name = excluded.name;
