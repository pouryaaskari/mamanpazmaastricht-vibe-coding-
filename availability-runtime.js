(() => {
  async function applyDeliveryAvailability() {
    const response = await fetch('/api/settings/delivery');
    if (!response.ok || (await response.json()).open) return;
    const deliveryOption = document.querySelector('input[name="order-method"][value="delivery"]');
    if (!deliveryOption) return;
    deliveryOption.disabled = true;
    const label = deliveryOption.closest('.checkout-option');
    label?.classList.add('is-disabled');
    const text = label?.querySelector('span');
    if (text) text.textContent = 'Delivery currently closed';
    if (deliveryOption.checked) {
      const takeaway = document.querySelector('input[name="order-method"][value="takeaway"]');
      takeaway.checked = true;
      takeaway.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  applyDeliveryAvailability().catch(() => {});
})();
