// Pure helpers shared by the driver and the tests.
export function fingerprint(snap) {
  if (!snap) return '';
  // Focus counts: clicking into a field changes nothing else, but it is the effect.
  const els = (snap.elements || []).map(e => `${e.ref}:${e.role}:${e.name}:${e.value}${e.focused ? ':f' : ''}`).join('|');
  return JSON.stringify({
    url: snap.url,
    text: (snap.text || '').slice(0, 4000),
    scrollY: snap.scrollY,
    viewport: snap.viewport,
    elements: els
  });
}

export function changed(before, after) {
  return fingerprint(before) !== fingerprint(after);
}

export function summarizeDelta(before, after) {
  if (!before || !after) return 'no comparison available';
  const bits = [];
  if (before.url !== after.url) bits.push(`url ${before.url} -> ${after.url}`);
  if (before.scrollY !== after.scrollY) bits.push(`scroll ${before.scrollY} -> ${after.scrollY}`);
  const a = new Map((after.elements || []).map(e => [e.ref, e]));
  for (const e of before.elements || []) {
    const n = a.get(e.ref);
    if (!n) bits.push(`removed #${e.ref} ${e.name}`);
    else if (n.value !== e.value) bits.push(`#${e.ref} ${e.name}: "${e.value}" -> "${n.value}"`);
  }
  const f = (s) => (s.elements || []).find(e => e.focused);
  const fb = f(before), fa = f(after);
  if (fa && fa.ref !== fb?.ref) bits.push(`focus -> #${fa.ref} ${fa.name}`);
  if ((after.text || '') !== (before.text || '')) bits.push('page text changed');
  return bits.length ? bits.join('; ') : 'no observable change';
}
