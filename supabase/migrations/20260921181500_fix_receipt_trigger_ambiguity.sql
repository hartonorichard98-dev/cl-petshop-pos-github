create or replace function public.assign_pos_receipt_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  receipt_month text;
  next_receipt_number bigint;
  current_receipt text;
begin
  select sales.receipt_number into current_receipt
  from public.sales sales
  where sales.store_id = new.store_id
    and sales.id = new.id;

  if current_receipt is not null then
    new.receipt_number := current_receipt;
    return new;
  end if;

  receipt_month := to_char(new.business_date, 'YYYYMM');
  perform pg_advisory_xact_lock(hashtextextended(new.store_id::text || receipt_month, 0));

  insert into public.pos_receipt_sequences (store_id, month_key, last_number)
  values (
    new.store_id,
    receipt_month,
    (
      select count(*)
      from public.sales existing
      where existing.store_id = new.store_id
        and to_char(existing.business_date, 'YYYYMM') = receipt_month
    )
  )
  on conflict (store_id, month_key) do nothing;

  update public.pos_receipt_sequences sequences
  set last_number = sequences.last_number + 1
  where sequences.store_id = new.store_id
    and sequences.month_key = receipt_month
  returning sequences.last_number into next_receipt_number;

  new.receipt_number := to_char(new.business_date, 'DDMMYY') || '-' ||
    case
      when next_receipt_number < 10000 then lpad(next_receipt_number::text, 4, '0')
      else next_receipt_number::text
    end;
  return new;
end;
$$;
