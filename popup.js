const STORAGE_KEY = 'middledot.layout';
const FLASH_MS = 1000;
const RESET_CONFIRM_MS = 3000;
// Версии 1.1 и раньше хранили раскладку плоским списком ячеек сетки в 5 столбцов
const LEGACY_COLUMNS = 5;
// Срезаем только обычные пробелы: неразрывный и прочие особые — тоже символы
const LEADING_SPACES = /^[ \t\r\n]+/;
// Символы без видимого знака: пробелы, управляющие и форматирующие, заполнители (DI)
// вроде U+3164, пустая клетка Брайля U+2800, заменитель объекта U+FFFC, диакритика без буквы
const INVISIBLE = /^[\p{White_Space}\p{Cc}\p{Cf}\p{DI}\p{M}\u2800\uFFFC]+$/u;

const TEXT = {
  hint: 'Click to copy',
  editHint: 'Click or drag cells',
  addSymbol: 'Add symbol',
  copied: 'Copied',
  copyFailed: 'Failed to copy',
  confirmReset: 'Click again to reset',
  resetDone: 'Reset to default',
};

const ui = {
  grid: document.getElementById('grid'),
  message: document.getElementById('message'),
  status: document.getElementById('status'),
  edit: document.getElementById('edit'),
  done: document.getElementById('done'),
  reset: document.getElementById('reset'),
};
// Сегментатор нужен только при правке, а в холодном процессе
// он стоит несколько миллисекунд до первой отрисовки
let segmenter = null;

// Раскладка по умолчанию и названия символов берутся из разметки popup.html
const DEFAULT_LAYOUT = normalize(
  [...ui.grid.rows].map(row => [...row.cells].map(cell => cell.textContent.trim())),
);
const NAMES = Object.fromEntries(
  [...ui.grid.querySelectorAll('td[data-name]')]
    .map(cell => [cell.textContent.trim(), cell.dataset.name]),
);

const state = {
  layout: loadLayout(),
  editing: false,
  hovered: null,  // { r, c } ячейки под курсором или в фокусе
  editor: null,   // { pos, input } — открытое поле ввода
  dragFrom: null, // { r, c } перетаскиваемой ячейки
  flashTimer: null,
  copiedTimer: null,
  resetTimer: null,
};

const copiedMark = createMark('copied');
const dragMark = createMark('dragging');
const dropMark = createMark('drop-target');

ui.grid.addEventListener('click', e => {
  const pos = ownCell(e.target);
  if (pos) activate(pos);
});
ui.grid.addEventListener('keydown', e => {
  const pos = ownCell(e.target);
  if (!pos || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  activate(pos);
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

// Таблица повторяет раскладку, а в режиме правки получает ещё свободную строку снизу
// и свободный столбец справа, чтобы символ можно было добавить за край
function renderGrid() {
  const extra = state.editing ? 1 : 0;
  const height = state.layout.length + extra;
  const width = (state.layout[0]?.length ?? 0) + extra;
  // Меняем только края: normalize и placeChar тоже растят и обрезают раскладку лишь
  // снизу и справа. Поэтому уцелевшая td остаётся на своём месте, а с ней и фокус
  // от щелчка, и роль источника перетаскивания
  while (ui.grid.rows.length > height) ui.grid.deleteRow(-1);
  while (ui.grid.rows.length < height) ui.grid.insertRow();
  for (const row of ui.grid.rows) {
    while (row.cells.length > width) row.deleteCell(-1);
    while (row.cells.length < width) row.insertCell();
    for (const cell of row.cells) {
      const ch = charAt(posOf(cell));
      cell.textContent = ch;
      cell.classList.toggle('char', ch !== '');
      cell.draggable = state.editing && ch !== '';
      // Строку сообщений скринридер при фокусе не читает, поэтому название и код символа
      // несёт сама ячейка, а пустое место в режиме правки подписано действием
      const label = ch ? nameOf(ch) : TEXT.addSymbol;
      // В обычном режиме пустые места пропускаются при навигации с клавиатуры
      if (state.editing || ch) {
        cell.tabIndex = 0;
        cell.setAttribute('role', 'button');
        cell.setAttribute('aria-label', label);
      } else {
        cell.removeAttribute('tabindex');
        cell.removeAttribute('role');
        cell.removeAttribute('aria-label');
      }
      // Код, который уже стал названием, второй раз не читаем
      const code = ch && codeOf(ch);
      if (code && code !== label) cell.setAttribute('aria-description', code);
      else cell.removeAttribute('aria-description');
    }
  }
}

function commitLayout(layout) {
  state.layout = layout;
  saveLayout(layout);
  renderGrid();
}

function activate(pos) {
  if (state.editing) openEditor(pos);
  else if (charAt(pos)) copySymbol(pos);
}

function charAt({ r, c }) {
  return state.layout[r]?.[c] ?? '';
}

function posOf(cell) {
  return { r: cell.parentElement.rowIndex, c: cell.cellIndex };
}

function cellAt(pos) {
  return pos ? ui.grid.rows[pos.r]?.cells[pos.c] ?? null : null;
}

function samePos(a, b) {
  return a?.r === b?.r && a?.c === b?.c;
}

// Место ячейки, если событие пришло от неё самой, а не от поля ввода внутри
function ownCell(target) {
  return target instanceof HTMLTableCellElement && ui.grid.contains(target) ? posOf(target) : null;
}

// Место ячейки, внутри которой произошло событие
function parentCell(target) {
  const el = target instanceof Element ? target : target?.parentElement;
  return ownCell(el?.closest('td'));
}

// Ячейка могла пропасть вместе с опустевшей строкой или столбцом — тогда берём ближайшую
function focusCell({ r, c }) {
  const row = ui.grid.rows[Math.min(r, ui.grid.rows.length - 1)];
  row?.cells[Math.min(c, row.cells.length - 1)]?.focus();
}

// Класс-метка, который стоит не больше чем на одной ячейке
function createMark(className) {
  let pos = null;
  return {
    set(next) {
      if (samePos(next, pos)) return;
      cellAt(pos)?.classList.remove(className);
      pos = next;
      cellAt(pos)?.classList.add(className);
    },
  };
}

// ---- Раскладка ----

// Строки одинаковой длины, без пустых строк снизу и пустых столбцов справа
function normalize(rows) {
  const height = rows.findLastIndex(row => row.some(ch => ch)) + 1;
  const width = Math.max(0, ...rows.map(row => row.findLastIndex(ch => ch) + 1));
  return Array.from({ length: height }, (_, r) =>
    Array.from({ length: width }, (_, c) => rows[r]?.[c] ?? ''));
}

function placeChar(layout, { r, c }, ch) {
  const rows = layout.map(row => [...row]);
  while (rows.length <= r) rows.push([]);
  rows[r][c] = ch;
  return normalize(rows);
}

// ---- Копирование ----

function copySymbol(pos) {
  // Подпись ставим сразу: первый writeText отвечает дольше, и без этого
  // клавиша успевает погаснуть после :active и загореться снова
  showCopied(pos);
  navigator.clipboard.writeText(charAt(pos)).then(() => {
    // Ответ, пришедший после hideCopied, не озвучиваем: убрать объявление было бы уже некому
    if (state.copiedTimer !== null) announce(TEXT.copied);
  }, err => {
    hideCopied();
    flash(TEXT.copyFailed, 'error');
    console.error(err);
  });
}

function showCopied(pos) {
  clearTimeout(state.copiedTimer);
  copiedMark.set(pos);
  state.copiedTimer = setTimeout(hideCopied, FLASH_MS);
}

function hideCopied() {
  clearTimeout(state.copiedTimer);
  state.copiedTimer = null;
  copiedMark.set(null);
  withdraw(TEXT.copied);
}

// ---- Режим правки ----

function setEditing(on) {
  closeEditor(true);
  state.editing = on;
  document.body.classList.toggle('editing', on);
  disarmReset();
  hideCopied();
  endFlash();
  // Смена режима собирает таблицу заново: все ячейки сразу появляются в новом виде, без перехода
  ui.grid.replaceChildren();
  renderGrid();
  (on ? ui.done : ui.edit).focus();
}

function openEditor(pos) {
  closeEditor(true);
  const input = document.createElement('input');
  input.className = 'cell-input';
  input.value = charAt(pos);
  input.setAttribute('aria-label', 'Symbol');
  input.addEventListener('keydown', e => {
    // Пока IME набирает текст, Tab выбирает кандидата: фокус Chrome не двигает, и набор не готов
    if (e.key === 'Tab' && e.isComposing) return;
    // Tab сохраняет правку до перехода фокуса: иначе браузер выберет следующую ячейку
    // по старой сетке и пропустит свободную, которую правка добавила рядом
    if (e.key === 'Enter' || e.key === 'Tab') closeEditor(true, true);
    // Сохранение удалило и саму ячейку: переход ведём от её места. Фокус ставим на последнюю
    // ячейку перед ним, оттуда Tab идёт дальше сам, а Shift+Tab на ней и останавливается
    if (e.key === 'Tab' && !cellAt(pos)) {
      focusCell({ r: pos.r, c: Infinity });
      if (e.shiftKey) e.preventDefault();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor(false, true);
    }
  });
  // blur может прийти от поля, которое уже закрыли другим способом
  input.addEventListener('blur', e => {
    if (state.editor?.input !== input) return;
    // Фокус уходит к ячейке по щелчку, а сохранение может удалить её вместе с опустевшим
    // краем. Тогда Chrome оставит фокус на body, поэтому ставим его на ближайшую ячейку
    const next = ownCell(e.relatedTarget);
    closeEditor(true);
    if (next && !e.relatedTarget.isConnected) focusCell(next);
  });
  cellAt(pos).replaceChildren(input);
  state.editor = { pos, input };
  input.focus();
  input.select();
}

function closeEditor(commit, refocus = false) {
  const { editor } = state;
  if (!editor) return;
  state.editor = null;
  const ch = firstGrapheme(editor.input.value.replace(LEADING_SPACES, ''));
  if (commit && ch !== charAt(editor.pos)) {
    commitLayout(placeChar(state.layout, editor.pos, ch));
  } else {
    renderGrid();
  }
  if (refocus) focusCell(editor.pos);
}

// ---- Перетаскивание ----

function startDrag(e) {
  const pos = ownCell(e.target);
  if (!pos) return;
  state.dragFrom = pos;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', charAt(pos));
  // Метку ставим после старта: иначе Chrome снимет «призрак» уже с бледной ячейки
  setTimeout(() => {
    if (samePos(state.dragFrom, pos)) dragMark.set(pos);
  });
}

function dragOver(e) {
  if (!state.dragFrom) return;
  const pos = parentCell(e.target);
  if (!pos) {
    dropMark.set(null);
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  dropMark.set(samePos(pos, state.dragFrom) ? null : pos);
}

// Подсветку снимаем, только когда символ унесли за сетку: между ячейками её переставит dragOver
function dragLeave(e) {
  if (!ui.grid.contains(e.relatedTarget)) dropMark.set(null);
}

function drop(e) {
  const from = state.dragFrom;
  const to = parentCell(e.target);
  if (!from || !to) return;
  e.preventDefault();
  // dragend не дойдёт до сетки, если перенос обрежет исходную ячейку вместе с опустевшим краем
  endDrag();
  if (samePos(from, to)) return;
  closeEditor(true);
  // На пустое место символ переезжает, на занятое — меняется местами
  const moved = charAt(from);
  commitLayout(placeChar(placeChar(state.layout, from, charAt(to)), to, moved));
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
  closeEditor(false);
  state.layout = DEFAULT_LAYOUT;
  clearSavedLayout();
  setEditing(false);
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

function hover(pos) {
  state.hovered = pos;
  if (state.flashTimer === null) showIdle();
}

// Временное сообщение: повторный вызов перезапускает таймер, а не копит старые
function flash(text, tone, ms = FLASH_MS) {
  clearTimeout(state.flashTimer);
  setMessage(text, tone);
  announce(text);
  state.flashTimer = setTimeout(endFlash, ms);
}

function endFlash() {
  clearTimeout(state.flashTimer);
  state.flashTimer = null;
  withdraw(ui.message.textContent);
  showIdle();
}

function showIdle() {
  const ch = state.hovered ? charAt(state.hovered) : '';
  if (ch) setMessage(describe(ch));
  else setMessage(state.editing ? TEXT.editHint : TEXT.hint);
}

function setMessage(text, tone = '') {
  ui.message.textContent = text;
  ui.message.className = tone;
}

// Живая область озвучивает только изменения, а тот же текст подряд изменением не считается:
// повтор отличаем неразрывным пробелом
function announce(text) {
  ui.status.textContent = ui.status.textContent === text ? `${text}\u00A0` : text;
}

// Объявление убираем вместе с его сообщением или подписью, чтобы скринридер не нашёл старое.
// Очистку живая область не озвучивает, а trimEnd снимает и неразрывный пробел повтора
function withdraw(text) {
  if (ui.status.textContent.trimEnd() === text) ui.status.textContent = '';
}

// ---- Символы ----

function describe(ch) {
  const code = codeOf(ch);
  return NAMES[ch] ? `${NAMES[ch]} · ${code}` : code;
}

// Невидимый символ прочитался бы пустотой, поэтому скринридеру вместо него называем код
function nameOf(ch) {
  return NAMES[ch] ?? (INVISIBLE.test(ch) ? codeOf(ch) : ch);
}

function codeOf(ch) {
  const hex = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  return `U+${hex}`;
}

function firstGrapheme(text) {
  segmenter ??= new Intl.Segmenter();
  const [first] = segmenter.segment(text);
  return first?.segment ?? '';
}

// ---- Хранилище ----

function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (isLegacyLayout(saved)) return normalize(chunk(saved, LEGACY_COLUMNS));
    if (isValidLayout(saved)) return normalize(saved);
  } catch (err) {
    console.error(err);
  }
  return DEFAULT_LAYOUT;
}

function isLegacyLayout(layout) {
  return Array.isArray(layout) && layout.every(ch => typeof ch === 'string');
}

function isValidLayout(layout) {
  return Array.isArray(layout)
    && layout.every(row => Array.isArray(row) && row.every(ch => typeof ch === 'string'));
}

function chunk(list, size) {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size));
}

function saveLayout(layout) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
}

function clearSavedLayout() {
  localStorage.removeItem(STORAGE_KEY);
}
