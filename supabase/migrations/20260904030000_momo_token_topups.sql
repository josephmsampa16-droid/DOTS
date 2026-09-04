-- Token top-ups over the existing MTN Mobile Money rail.
--
-- momo_transactions was built for car-hire bookings. Top-ups reuse it, so the
-- table needs to say which kind of payment a row is and, for a top-up, who is
-- buying and how many tokens they are owed on success.

alter table public.momo_transactions
  add column if not exists purpose text not null default 'booking',
  add column if not exists driver_id uuid references public.profiles(id) on delete set null,
  add column if not exists token_quantity integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'momo_transactions_purpose_check') then
    alter table public.momo_transactions add constraint momo_transactions_purpose_check
      check (purpose in ('booking','token_topup'));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'momo_transactions_topup_shape') then
    alter table public.momo_transactions add constraint momo_transactions_topup_shape check (
      (purpose = 'token_topup' and driver_id is not null and token_quantity > 0)
      or (purpose = 'booking' and token_quantity is null)
    );
  end if;
end $$;

-- The property that really matters: one payment can never credit tokens twice,
-- however many times the app polls or however the calls race. The database
-- refuses the second insert rather than trusting the caller to check first.
create unique index if not exists token_ledger_one_credit_per_payment
  on public.token_ledger (momo_transaction_id) where reason = 'topup';

-- Drivers may read their own payment rows so the app can show progress. Nothing
-- is writable from a client; only the edge functions, which hold the service
-- role key, create or update these.
alter table public.momo_transactions enable row level security;

drop policy if exists "Drivers read own topups" on public.momo_transactions;
create policy "Drivers read own topups" on public.momo_transactions
  for select to authenticated
  using (purpose = 'token_topup' and driver_id = auth.uid());

drop policy if exists "Staff read all momo" on public.momo_transactions;
create policy "Staff read all momo" on public.momo_transactions
  for select to authenticated
  using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'Staff'));

grant select on public.momo_transactions to authenticated;
