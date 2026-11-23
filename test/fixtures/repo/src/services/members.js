'use strict';
const { makeMember } = require('../models/member');

function createMembers(store) {
  return {
    addMember(m) {
      const member = makeMember(m);
      if (store.data.members.some((x) => x.id === member.id)) throw new Error(`čtenář ${member.id} už existuje`);
      store.data.members.push(member); store.save();
      return member;
    },
    getMember(id) { return store.data.members.find((m) => m.id === id) || null; },
  };
}
module.exports = { createMembers };
