const grid = document.getElementById('grid');
const message = document.getElementById('message');
const HINT = 'Click to copy';

let current = null; // ячейка под курсором или в фокусе
let copied = null;  // последняя скопированная ячейка
let timer = null;

grid.querySelectorAll('.char').forEach(cell => {
  cell.tabIndex = 0;
  cell.setAttribute('role', 'button');

  cell.addEventListener('click', () => copy(cell));
  cell.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      copy(cell);
    }
  });
  cell.addEventListener('mouseenter', () => point(cell));
  cell.addEventListener('focus', () => point(cell));
  cell.addEventListener('mouseleave', () => point(null));
  cell.addEventListener('blur', () => point(null));
});

setMessage(HINT);

async function copy(cell) {
  const ch = cell.textContent;
  try {
    await navigator.clipboard.writeText(ch);
    copied?.classList.remove('copied');
    copied = cell;
    cell.classList.add('copied');
    flash(`Copied ${ch}`, 'ok');
  } catch (err) {
    flash('Failed to copy', 'error');
    console.error(err);
  }
}

function point(cell) {
  current = cell;
  if (!timer) setMessage(idleText());
}

// Один общий таймер: повторный клик перезапускает его, а не копит старые
function flash(text, state) {
  clearTimeout(timer);
  setMessage(text, state);
  timer = setTimeout(() => {
    timer = null;
    copied?.classList.remove('copied');
    copied = null;
    setMessage(idleText());
  }, 1000);
}

function setMessage(text, state = '') {
  message.textContent = text;
  message.className = state;
}

function idleText() {
  return current ? describe(current) : HINT;
}

function describe(cell) {
  const hex = cell.textContent.codePointAt(0).toString(16).toUpperCase();
  const code = `U+${hex.padStart(4, '0')}`;
  return cell.dataset.name ? `${cell.dataset.name} · ${code}` : code;
}
