(() => {
  const list = document.getElementById('types');
  const tpl = document.getElementById('type-template');
  const btn = document.getElementById('add-type');
  if (!list || !tpl || !btn) return;
  let next = list.children.length;
  btn.addEventListener('click', () => {
    const html = tpl.innerHTML.replaceAll('__i__', String(next++));
    list.insertAdjacentHTML('beforeend', html);
  });
})();
