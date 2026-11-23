'use strict';
// Úložiště žáků, známek a rozvrhu v jednom JSON souboru (nebo jen v paměti, když file chybí).
const fs = require('fs');

function createStore(file) {
  let data = { students: [], grades: [], lessons: [] };
  if (file && fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const save = () => { if (file) fs.writeFileSync(file, JSON.stringify(data, null, 2)); };
  return {
    data,
    save,
    addStudent(id, name) {
      if (data.students.some((s) => s.id === id)) throw new Error(`student ${id} already exists`);
      data.students.push({ id, name });
      save();
    },
    student(id) { return data.students.find((s) => s.id === id) || null; },
    addGrade(g) { data.grades.push({ weight: 1, ...g }); save(); },
    gradesOf(id) { return data.grades.filter((g) => g.student === id); },
    addLesson(l) { data.lessons.push(l); save(); },
  };
}

module.exports = { createStore };
