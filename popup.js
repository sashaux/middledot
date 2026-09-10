const grid = document.getElementById('grid');
const message = document.getElementById('message');
const editButton = document.getElementById('edit');
const doneButton = document.getElementById('done');
const resetButton = document.getElementById('reset');

const STORAGE_KEY = 'middledot.layout';
const HINT = 'Click to copy';
const EDIT_HINT = 'Drag to move · click to change';
const RESET_LABEL = resetButton.textContent;

const cells = [...grid.querySelectorAll('td')];
const segmenter = new Intl.Segmenter();

// Раскладка по умолчанию и названия символов берутся из разметки popup.html
const DEFAULT_LAYOUT = cells.map(cell => cell.textContent.trim());
const NAMES = {};
cells.forEach(cell => {
  if (cell.dataset.name) NAMES[cell.textContent.trim()] = cell.dataset.name;
});

let layout = loadLayout();
let editing = false;
let current = null; // индекс ячейки под курсором или в фокусе
let copied = null;  // последняя скопированная ячейка
let dragFrom = null;
let timer = null;
let resetTimer = null;
let finishEdit = null; // закрывает открытое поле ввода, если оно есть

cells.forEach((cell, i) => {
  cell.addEventListener('click', e => {
    if (e.target === cell) activate(i);
  });
  cell.addEventListener('keydown', e => {
    if (e.target !== cell || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    activate(i);
  });
  cell.addEventListener('mouseenter', () => point(i));
  cell.addEventListener('focus', () => point(i));
  cell.addEventListener('mouseleave', () => point(null));
  cell.addEventListener('blur', () => point(null));

  cell.addEventListener('dragstart', e => {
    dragFrom = i;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', layout[i]);
    cell.classList.add('dragging');
  });
  cell.addEventListener('dragover', e => {
    if (dragFrom === null) return;
    e.preventDefault();
    cell.classList.add('drop-target');
  });
  cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
  cell.addEventListener('drop', e => {
    e.preventDefault();
    cell.classList.remove('drop-target');
    if (dragFrom === null || dragFrom === i) return;
    finishEdit?.(true, false);
    // На пустое место символ переезжает, на занятое — меняется местами
    [layout[dragFrom], layout[i]] = [layout[i], layout[dragFrom]];
    saveLayout();
    render();
  });
  cell.addEventListener('dragend', () => {
    cell.classList.remove('dragging');
    dragFrom = null;
  });
});

editButton.addEventListener('click', () => setEditing(true));
doneButton.addEventListener('click', () => setEditing(false));
resetButton.addEventListener('click', resetLayout);

render();
setMessage(idleText());

function render() {
  cells.forEach((cell, i) => {
    const ch = layout[i];
    cell.textContent = ch;
    cell.classList.toggle('char', ch !== '');
    cell.draggable = editing && ch !== '';
    if (editing || ch) {
      cell.tabIndex = 0;
      cell.setAttribute('role', 'button');
    } else {
      cell.removeAttribute('tabindex');
      cell.removeAttribute('role');
    }
  });
}

function activate(i) {
  if (editing) startEdit(i);
  else if (layout[i]) copy(i);
}

async function copy(i) {
  const ch = layout[i];
  try {
    await navigator.clipboard.writeText(ch);
    copied?.classList.remove('copied');
    copied = cells[i];
    copied.classList.add('copied');
    flash(`Copied ${ch}`, 'ok');
  } catch (err) {
    flash('Failed to copy', 'error');
    console.error(err);
  }
}

function startEdit(i) {
  finishEdit?.(true, false);
  const cell = cells[i];
  const input = document.createElement('input');
  input.className = 'cell-input';
  input.value = layout[i];
  input.setAttribute('aria-label', 'Symbol');
  cell.textContent = '';
  cell.append(input);
  input.focus();
  input.select();

  const finish = (commit, refocus) => {
    if (finishEdit !== finish) return;
    finishEdit = null;
    // Срезаем только обычные пробелы: неразрывный и прочие особые — тоже символы
    const next = firstGrapheme(input.value.replace(/^[ \t\r\n]+/, ''));
    if (commit && next !== layout[i]) {
      layout[i] = next;
      saveLayout();
    }
    render();
    if (refocus) cell.focus();
  };
  finishEdit = finish;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true, true);
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false, true);
    }
  });
  input.addEventListener('blur', () => finish(true, false));
}

function setEditing(on) {
  finishEdit?.(true, false);
  editing = on;
  document.body.classList.toggle('editing', on);
  cancelReset();
  endFlash();
  render();
  (on ? doneButton : editButton).focus();
}

// Сброс срабатывает со второго нажатия, чтобы не потерять раскладку случайно
function resetLayout() {
  if (!resetTimer) {
    resetButton.textContent = 'Click again to reset';
    resetButton.classList.add('confirm');
    resetTimer = setTimeout(cancelReset, 3000);
    return;
  }
  cancelReset();
  localStorage.removeItem(STORAGE_KEY);
  layout = [...DEFAULT_LAYOUT];
  render();
  flash('Reset to default', 'ok');
}

function cancelReset() {
  clearTimeout(resetTimer);
  resetTimer = null;
  resetButton.textContent = RESET_LABEL;
  resetButton.classList.remove('confirm');
}

function point(i) {
  current = i;
  if (!timer) setMessage(idleText());
}

// Один общий таймер: повторный клик перезапускает его, а не копит старые
function flash(text, state) {
  clearTimeout(timer);
  setMessage(text, state);
  timer = setTimeout(endFlash, 1000);
}

function endFlash() {
  clearTimeout(timer);
  timer = null;
  copied?.classList.remove('copied');
  copied = null;
  setMessage(idleText());
}

function setMessage(text, state = '') {
  message.textContent = text;
  message.className = state;
}

function idleText() {
  if (current !== null && layout[current]) return describe(layout[current]);
  return editing ? EDIT_HINT : HINT;
}

function describe(ch) {
  const hex = ch.codePointAt(0).toString(16).toUpperCase();
  const code = `U+${hex.padStart(4, '0')}`;
  return NAMES[ch] ? `${NAMES[ch]} · ${code}` : code;
}

function firstGrapheme(text) {
  const [first] = segmenter.segment(text);
  return first ? first.segment : '';
}

function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const valid = Array.isArray(saved)
      && saved.length === cells.length
      && saved.every(ch => typeof ch === 'string');
    if (valid) return saved;
  } catch (err) {
    console.error(err);
  }
  return [...DEFAULT_LAYOUT];
}

function saveLayout() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
}
