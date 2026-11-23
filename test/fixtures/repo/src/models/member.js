'use strict';
/** Čtenář: id (zkratka), jméno, třída. */
function makeMember({ id, name, grade = '' }) {
  if (!/^[a-z0-9]{2,12}$/.test(String(id || ''))) throw new Error(`neplatné id čtenáře ${id}`);
  if (!String(name || '').trim()) throw new Error('čtenář musí mít jméno');
  return { id, name: String(name).trim(), grade: String(grade).trim() };
}
module.exports = { makeMember };
