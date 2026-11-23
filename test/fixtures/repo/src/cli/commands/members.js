'use strict';
module.exports = {
  'add-member': {
    usage: 'add-member <id> <jméno…>', min: 2, max: 9,
    run([id, ...name], { lib }) {
      const m = lib.members.addMember({ id, name: name.join(' ') });
      return { code: 0, out: `přidán čtenář ${m.name} (${m.id})` };
    },
  },
};
