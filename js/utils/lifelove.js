export function getQuarterKey(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  let quarter;
  let qYear = year;
  if (month >= 3 && month <= 5) {
    quarter = 1;
  } else if (month >= 6 && month <= 8) {
    quarter = 2;
  } else if (month >= 9 && month <= 11) {
    quarter = 3;
  } else {
    quarter = 4;
    qYear = year - 1;
  }
  return `${qYear}-Q${quarter}`;
}

export function filterProvisionsByQuarter(list, quarterKey) {
  if (!quarterKey) return list;
  return list.filter((p) => p.quarterKey === quarterKey);
}

export function updateCustomerLifeLove(prev = {}, quarterKey, enabled = true) {
  if (!enabled) return prev || {};
  return { ...(prev || {}), [quarterKey]: true };
}
