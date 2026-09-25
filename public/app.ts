const form = document.getElementById('join') as HTMLFormElement;
form.addEventListener('submit', event => {
  event.preventDefault();
  const code = (document.getElementById('code') as HTMLInputElement).value.trim().toUpperCase();
  const name = (document.getElementById('team') as HTMLInputElement).value.trim();
  if (!/^[A-Z2-9]{8}$/.test(code) || !name) return;
  location.href = `/player.html?${new URLSearchParams({ code, name })}`;
});
