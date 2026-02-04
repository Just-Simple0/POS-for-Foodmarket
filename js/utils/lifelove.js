export function getQuarterKey(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;

  let quarter;
  if (month >= 1 && month <= 3) {
    quarter = 1;
  } else if (month >= 4 && month <= 6) {
    quarter = 2;
  } else if (month >= 7 && month <= 9) {
    quarter = 3;
  } else {
    quarter = 4;
  }
  return `${year}-Q${quarter}`;
}

export function filterProvisionsByQuarter(list, quarterKey) {
  if (!quarterKey) return list;
  return list.filter((p) => p.quarterKey === quarterKey);
}

export function updateCustomerLifeLove(prev = {}, quarterKey, enabled = true) {
  if (!enabled) return prev || {};
  return { ...(prev || {}), [quarterKey]: true };
}
