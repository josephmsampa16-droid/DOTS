-- Signup metadata carries the phone number, but the profile row was created
-- without it, so a rider's number never reached the driver who needed to call
-- them (the driver app backfilled its own; the rider app never did). Copy it
-- at signup, where it belongs. Existing rows with a phone are left alone.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  insert into public.profiles (id, name, phone, role)
  values (
    new.id,
    new.raw_user_meta_data ->> 'name',
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    case
      when new.raw_user_meta_data ->> 'intended_role' = 'Driver' then 'Driver'
      when new.raw_user_meta_data ->> 'intended_role' = 'Rider' then 'Rider'
      else 'Owner'
    end
  );
  return new;
end;
$function$;

-- Riders who signed up before this: their phone is still in auth metadata.
update public.profiles p
   set phone = nullif(trim(u.raw_user_meta_data ->> 'phone'), '')
  from auth.users u
 where u.id = p.id
   and p.phone is null
   and nullif(trim(u.raw_user_meta_data ->> 'phone'), '') is not null;
