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
