(() => {
  const form = document.getElementById('checkout');
  const total = document.getElementById('total');
  if (!form || !total) return;
  const fmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
  const update = () => {
    let cents = 0;
    for (const s of form.querySelectorAll('select[data-price]')) cents += Number(s.value) * Number(s.dataset.price);
    total.textContent = fmt.format(cents / 100);
  };
  form.addEventListener('change', update);
  update();
})();

// Share button: use the phone's share sheet where there is one, otherwise copy the link.
(() => {
  const btn = document.getElementById('share');
  if (!btn) return;
  const { title, url } = btn.dataset;
  if (!navigator.share && !navigator.clipboard) return;
  btn.hidden = false;
  if (!navigator.share) btn.textContent = 'Copy link';
  btn.addEventListener('click', async () => {
    try {
      if (navigator.share) await navigator.share({ title, url });
      else {
        await navigator.clipboard.writeText(url);
        btn.textContent = 'Link copied';
        setTimeout(() => { btn.textContent = 'Copy link'; }, 2000);
      }
    } catch { /* share sheet dismissed */ }
  });
})();
