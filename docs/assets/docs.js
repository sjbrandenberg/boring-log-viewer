// Mobile menu, heading anchors and copy buttons for the documentation pages.
const menu = document.querySelector('.menu-button');
const sidebar = document.getElementById('sidebar');
menu.addEventListener('click', () => {
    const open = sidebar.classList.toggle('open');
    menu.setAttribute('aria-expanded', String(open));
});

for (const h of document.querySelectorAll('.content h2[id], .content h3[id]')) {
    const a = document.createElement('a');
    a.className = 'anchor';
    a.href = `#${h.id}`;
    a.textContent = '#';
    a.setAttribute('aria-label', 'Link to this section');
    h.append(a);
}

for (const pre of document.querySelectorAll('.content pre')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = 'Copy';
    button.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText);
            button.textContent = 'Copied';
        } catch {
            button.textContent = 'Select and copy';
        }
        setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    });
    pre.append(button);
}
