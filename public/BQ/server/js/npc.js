
module.exports = Npc = Entity.extend({
    init: function(id, kind, x, y) {
        this._super(id, "npc", kind, x, y);
    }
});