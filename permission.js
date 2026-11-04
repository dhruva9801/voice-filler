navigator.mediaDevices.getUserMedia({ audio: true })
  .then(s => { s.getTracks().forEach(t => t.stop()); document.body.textContent = 'Mic granted. Close this tab.'; })
  .catch(e => { document.body.textContent = 'Denied: ' + e.name; });