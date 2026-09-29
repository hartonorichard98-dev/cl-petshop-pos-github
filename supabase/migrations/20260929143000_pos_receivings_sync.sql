alter table public.receivings
  add column if not exists created_by_name text,
  add column if not exists checked_by_name text,
  add column if not exists approved_by_name text,
  add column if not exists stock_applied_at timestamptz,
  add column if not exists deleted_at timestamptz;

create or replace function public.pos_sync_receivings(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text,
  p_receivings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  staff public.pos_staff_credentials;
  expected_secret_hash text;
  incoming jsonb;
  receiving_id uuid;
  incoming_status public.receiving_status;
  incoming_updated timestamptz;
  existing public.receivings;
  pulled_receivings jsonb;
begin
  select api_secret_hash into expected_secret_hash
  from public.pos_sync_config
  where store_id = p_store_id;

  if expected_secret_hash is null or encode(digest(p_api_secret, 'sha256'), 'hex') <> expected_secret_hash then
    raise exception 'Invalid sync secret';
  end if;

  select * into staff
  from public.pos_staff_credentials
  where store_id = p_store_id
    and username = lower(btrim(p_username))
    and active = true;

  if staff.store_id is null or not (staff.pin_hash = crypt(p_pin, staff.pin_hash)) then
    raise exception 'Invalid POS login';
  end if;

  if jsonb_typeof(coalesce(p_receivings, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_receivings, '[]'::jsonb)) > 200 then
    raise exception 'Invalid receiving payload';
  end if;

  for incoming in select value from jsonb_array_elements(coalesce(p_receivings, '[]'::jsonb)) loop
    receiving_id := (incoming->>'id')::uuid;
    incoming_status := case coalesce(incoming->>'status', 'waiting_check')
      when 'owner_review' then 'owner_review'::public.receiving_status
      when 'approved' then 'approved'::public.receiving_status
      else 'waiting_check'::public.receiving_status
    end;
    incoming_updated := coalesce(
      nullif(incoming->>'updatedAt', '')::timestamptz,
      nullif(incoming->>'approvedAt', '')::timestamptz,
      nullif(incoming->>'checkedAt', '')::timestamptz,
      nullif(incoming->>'createdAt', '')::timestamptz,
      now()
    );

    select * into existing
    from public.receivings
    where id = receiving_id and store_id = p_store_id;

    if staff.role = 'cashier' then
      if existing.id is null then
        raise exception 'Only owner can create receiving';
      end if;
      if incoming_status <> 'owner_review' or existing.status <> 'waiting_check' then
        raise exception 'Cashier can only submit receiving check';
      end if;

      update public.receivings
      set items = coalesce(incoming->'items', existing.items),
          cashier_note = nullif(btrim(incoming->>'cashierNote'), ''),
          review_note = null,
          status = 'owner_review',
          checked_by_name = coalesce(nullif(btrim(incoming->>'checkedBy'), ''), staff.display_name),
          checked_at = coalesce(nullif(incoming->>'checkedAt', '')::timestamptz, incoming_updated),
          updated_at = incoming_updated
      where id = receiving_id
        and store_id = p_store_id
        and incoming_updated > updated_at;
    else
      if nullif(btrim(incoming->>'number'), '') is null
         or nullif(btrim(incoming->>'supplier'), '') is null
         or jsonb_typeof(coalesce(incoming->'items', '[]'::jsonb)) <> 'array' then
        raise exception 'Invalid receiving payload';
      end if;

      insert into public.receivings (
        id, store_id, receiving_number, supplier, reference_number, expected_date,
        owner_note, cashier_note, review_note, items, status,
        created_by_name, checked_by_name, approved_by_name,
        created_at, checked_at, approved_at, stock_applied_at, deleted_at, updated_at
      ) values (
        receiving_id,
        p_store_id,
        btrim(incoming->>'number'),
        btrim(incoming->>'supplier'),
        nullif(btrim(incoming->>'reference'), ''),
        nullif(incoming->>'expectedDate', '')::date,
        nullif(btrim(incoming->>'ownerNote'), ''),
        nullif(btrim(incoming->>'cashierNote'), ''),
        nullif(btrim(incoming->>'reviewNote'), ''),
        coalesce(incoming->'items', '[]'::jsonb),
        case when incoming->>'status' = 'deleted' then 'waiting_check'::public.receiving_status else incoming_status end,
        coalesce(nullif(btrim(incoming->>'createdBy'), ''), staff.display_name),
        nullif(btrim(incoming->>'checkedBy'), ''),
        nullif(btrim(incoming->>'approvedBy'), ''),
        coalesce(nullif(incoming->>'createdAt', '')::timestamptz, incoming_updated),
        nullif(incoming->>'checkedAt', '')::timestamptz,
        nullif(incoming->>'approvedAt', '')::timestamptz,
        nullif(incoming->>'stockAppliedAt', '')::timestamptz,
        case when incoming->>'status' = 'deleted' then incoming_updated else null end,
        incoming_updated
      )
      on conflict (id) do update set
        receiving_number = excluded.receiving_number,
        supplier = excluded.supplier,
        reference_number = excluded.reference_number,
        expected_date = excluded.expected_date,
        owner_note = excluded.owner_note,
        cashier_note = excluded.cashier_note,
        review_note = excluded.review_note,
        items = excluded.items,
        status = excluded.status,
        created_by_name = excluded.created_by_name,
        checked_by_name = excluded.checked_by_name,
        approved_by_name = excluded.approved_by_name,
        checked_at = excluded.checked_at,
        approved_at = excluded.approved_at,
        stock_applied_at = excluded.stock_applied_at,
        deleted_at = excluded.deleted_at,
        updated_at = excluded.updated_at
      where excluded.updated_at > public.receivings.updated_at;
    end if;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(receivings) order by receivings.created_at desc), '[]'::jsonb)
  into pulled_receivings
  from public.receivings
  where store_id = p_store_id;

  return jsonb_build_object('role', staff.role, 'receivings', pulled_receivings);
end;
$$;

revoke execute on function public.pos_sync_receivings(text, uuid, text, text, jsonb) from public;
grant execute on function public.pos_sync_receivings(text, uuid, text, text, jsonb) to anon, authenticated;
