var myKnob = pureknob.createKnob(300, 300);
myKnob.setProperty(propertyName, value);
myKnob.setValue(70);
myKnob.setPeaks([80]);
var node = knob.node();
var elem = document.getElementById('demo');
elem.appendChild(node);
var listener = function(knob, value) {
  console.log(value);
};

knob.addListener(listener);
