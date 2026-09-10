const STORAGE_KEY = 'middledot.layout';
const FLASH_MS = 1000;
const RESET_CONFIRM_MS = 3000;
// Срезаем только обычные пробелы: неразрывный и прочие особые — тоже символы
const LEADING_SPACES = /^[ \t\r\n]+/;

const TEXT = {
  hint: 'Click to copy',
  editHint: 'Click or drag cells',
  copied: ch => `Copied ${ch}`,
  copyFailed: 'Failed to copy',
  confirmReset: 'Click again to reset',
  resetDone: 'Reset to default',
};

const ui = {
  grid: document.getElementById('grid'),
  message: document.getElementById('message'),
  edit: document.getElementById('edit'),
  done: document.getElementById('done'),
  reset: document.getElementById('reset'),
};
const cells = [...ui.grid.querySelectorAll('td')];
const segmenter = new Intl.Segmenter();

// Раскладка по умолчанию и названия символов берутся из разметки popup.html
const DEFAULT_LAYOUT = cells.map(cell => cell.textContent.trim());
const NAMES = Object.fromEntries(
  cells
    .filter(cell => cell.dataset.name)
    .map(cell => [cell.textContent.trim(), cell.dataset.name]),
);

const state = {
  layout: loadLayout(),
  editing: false,
  hovered: null,  // индекс ячейки под курсором или в фокусе
  editor: null,   // { index, input } — открытое поле ввода
  dragFrom: null, // индекс перетаскиваемой ячейки
  flashTimer: null,
  resetTimer: null,
};

const copiedMark = createMark('copied');
const dragMark = createMark('dragging');
const dropMark = createMark('drop-target');

ui.grid.addEventListener('click', e => {
  const i = ownCell(e.target);
  if (i !== null) activate(i);
});
ui.grid.addEventListener('keydown', e => {
  const i = ownCell(e.target);
  if (i === null || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  activate(i);
});
ui.grid.addEventListener('mouseover', e => hover(parentCell(e.target)));
ui.grid.addEventListener('mouseleave', () => hover(null));
ui.grid.addEventListener('focusin', e => hover(ownCell(e.target)));
ui.grid.addEventListener('focusout', () => hover(null));

ui.grid.addEventListener('dragstart', startDrag);
ui.grid.addEventListener('dragenter', dragOver);
ui.grid.addEventListener('dragover', dragOver);
ui.grid.addEventListener('dragleave', dragLeave);
ui.grid.addEventListener('drop', drop);
ui.grid.addEventListener('dragend', endDrag);

ui.edit.addEventListener('click', () => setEditing(true));
ui.done.addEventListener('click', () => setEditing(false));
ui.reset.addEventListener('click', requestReset);

renderGrid();
showIdle();

// ---- Сетка ----

function renderGrid() {
  cells.forEach((cell, i) => {
    const ch = state.layout[i];
    cell.textContent = ch;
    cell.classList.toggle('char', ch !== '');
    cell.draggable = state.editing && ch !== '';
    // В обычном режиме пустые места пропускаются при навигации с клавиатуры
    if (state.editing || ch) {
      cell.tabIndex = 0;
      cell.setAttribute('role', 'button');
    } else {
      cell.removeAttribute('tabindex');
      cell.removeAttribute('role');
    }
  });
}

function commitLayout(layout) {
  state.layout = layout;
  saveLayout(layout);
  renderGrid();
}

function activate(i) {
  if (state.editing) openEditor(i);
  else if (state.layout[i]) copySymbol(i);
}

// Индекс ячейки, если событие пришло от неё самой, а не от поля ввода внутри
function ownCell(target) {
  const i = cells.indexOf(target);
  return i === -1 ? null : i;
}

// Индекс ячейки, внутри которой произошло событие
function parentCell(target) {
  const el = target instanceof Element ? target : target?.parentElement;
  return ownCell(el?.closest('td'));
}

// Класс-метка, который стоит не больше чем на одной ячейке
function createMark(className) {
  let index = null;
  return {
    set(i) {
      if (i === index) return;
      if (index !== null) cells[index].classList.remove(className);
      index = i;
      if (i !== null) cells[i].classList.add(className);
    },
  };
}

// ---- Копирование ----

async function copySymbol(i) {
  const ch = state.layout[i];
  try {
    await navigator.clipboard.writeText(ch);
    copiedMark.set(i);
    flash(TEXT.copied(ch), 'ok');
  } catch (err) {
    flash(TEXT.copyFailed, 'error');
    console.error(err);
  }
}

// ---- Режим правки ----

function setEditing(on) {
  closeEditor(true);
  state.editing = on;
  document.body.classList.toggle('editing', on);
  disarmReset();
  endFlash();
  renderGrid();
  (on ? ui.done : ui.edit).focus();
}

function openEditor(i) {
  closeEditor(true);
  const input = document.createElement('input');
  input.className = 'cell-input';
  input.value = state.layout[i];
  input.setAttribute('aria-label', 'Symbol');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') closeEditor(true, true);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor(false, true);
    }
  });
  // blur может прийти от поля, которое уже закрыли другим способом
  input.addEventListener('blur', () => {
    if (state.editor?.input === input) closeEditor(true);
  });
  cells[i].replaceChildren(input);
  state.editor = { index: i, input };
  input.focus();
  input.select();
}

function closeEditor(commit, refocus = false) {
  const { editor } = state;
  if (!editor) return;
  state.editor = null;
  const ch = firstGrapheme(editor.input.value.replace(LEADING_SPACES, ''));
  if (commit && ch !== state.layout[editor.index]) {
    commitLayout(state.layout.with(editor.index, ch));
  } else {
    renderGrid();
  }
  if (refocus) cells[editor.index].focus();
}

// ---- Перетаскивание ----

function startDrag(e) {
  const i = ownCell(e.target);
  if (i === null) return;
  state.dragFrom = i;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', state.layout[i]);
  // Метку ставим после старта: иначе Chrome снимет «призрак» уже с бледной ячейки
  setTimeout(() => {
    if (state.dragFrom === i) dragMark.set(i);
  });
}

function dragOver(e) {
  if (state.dragFrom === null) return;
  const i = parentCell(e.target);
  if (i === null) {
    dropMark.set(null);
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  dropMark.set(i === state.dragFrom ? null : i);
}

// Подсветку снимаем, только когда символ унесли за сетку: между ячейками её переставит dragOver
function dragLeave(e) {
  if (!ui.grid.contains(e.relatedTarget)) dropMark.set(null);
}

function drop(e) {
  const from = state.dragFrom;
  const to = parentCell(e.target);
  if (from === null || to === null) return;
  e.preventDefault();
  dropMark.set(null);
  if (from === to) return;
  closeEditor(true);
  // На пустое место символ переезжает, на занятое — меняется местами
  const layout = [...state.layout];
  [layout[from], layout[to]] = [layout[to], layout[from]];
  commitLayout(layout);
}

function endDrag() {
  state.dragFrom = null;
  dragMark.set(null);
  dropMark.set(null);
}

// ---- Сброс ----

// Сброс срабатывает со второго нажатия, чтобы не потерять раскладку случайно
function requestReset() {
  if (state.resetTimer === null) {
    armReset();
    return;
  }
  disarmReset();
  closeEditor(false);
  state.layout = [...DEFAULT_LAYOUT];
  clearSavedLayout();
  renderGrid();
  flash(TEXT.resetDone, 'ok');
}

function armReset() {
  ui.reset.classList.add('confirm');
  state.resetTimer = setTimeout(disarmReset, RESET_CONFIRM_MS);
  flash(TEXT.confirmReset, 'error', RESET_CONFIRM_MS);
}

function disarmReset() {
  clearTimeout(state.resetTimer);
  state.resetTimer = null;
  ui.reset.classList.remove('confirm');
}

// ---- Строка сообщений ----

function hover(i) {
  state.hovered = i;
  if (state.flashTimer === null) showIdle();
}

// Временное сообщение: повторный вызов перезапускает таймер, а не копит старые
function flash(text, tone, ms = FLASH_MS) {
  clearTimeout(state.flashTimer);
  setMessage(text, tone);
  state.flashTimer = setTimeout(endFlash, ms);
}

function endFlash() {
  clearTimeout(state.flashTimer);
  state.flashTimer = null;
  copiedMark.set(null);
  showIdle();
}

function showIdle() {
  const ch = state.hovered === null ? '' : state.layout[state.hovered];
  if (ch) setMessage(describe(ch));
  else setMessage(state.editing ? TEXT.editHint : TEXT.hint);
}

function setMessage(text, tone = '') {
  ui.message.textContent = text;
  ui.message.className = tone;
}

// ---- Символы ----

function describe(ch) {
  const hex = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  const code = `U+${hex}`;
  return NAMES[ch] ? `${NAMES[ch]} · ${code}` : code;
}

function firstGrapheme(text) {
  const [first] = segmenter.segment(text);
  return first?.segment ?? '';
}

// ---- Хранилище ----

function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (isValidLayout(saved)) return saved;
  } catch (err) {
    console.error(err);
  }
  return [...DEFAULT_LAYOUT];
}

// Сохранённая раскладка подходит, только если размер сетки в popup.html не менялся
function isValidLayout(layout) {
  return Array.isArray(layout)
    && layout.length === DEFAULT_LAYOUT.length
    && layout.every(ch => typeof ch === 'string');
}

function saveLayout(layout) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
}

function clearSavedLayout() {
  localStorage.removeItem(STORAGE_KEY);
}
