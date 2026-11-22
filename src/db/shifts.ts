/**
 * Which open shift a sale or payment belongs to. On a till: the till's cash
 * drawer, whoever opened its shift (cashiers share the drawer). Anywhere
 * else: the person's own open shift, if they have one that is not a till's.
 *
 * Returns a SQL subquery; the arguments are the placeholders ("$1") holding
 * the business, the person and the till (null when not on a till).
 */
export function openShiftSql(tenant: string, user: string, device: string): string {
  return `(select s.id from register_shifts s where s.tenant_id = ${tenant} and s.closed_at is null and
    (case when ${device}::uuid is null then s.opened_by = ${user}::uuid and s.device_id is null
          else s.register_id = (select p.register_id from pos_devices p where p.id = ${device}::uuid and p.tenant_id = ${tenant}) end)
    order by s.opened_at desc limit 1)`;
}
