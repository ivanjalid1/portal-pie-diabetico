'use strict';

/**
 * Recomendaciones de autocuidado del pie diabético para el portal del
 * paciente, redactadas en lenguaje simple. Basadas en las pautas generales de
 * educación diabetológica (IWGDF / guías nacionales); no reemplazan la
 * indicación del equipo de salud.
 */
const SELF_CARE = Object.freeze([
  {
    icon: 'eye',
    titulo: 'Revisá tus pies todos los días',
    texto:
      'Mirá la planta, los talones y entre los dedos. Usá un espejo o pedí ayuda. Buscá cortes, ampollas, enrojecimiento, hinchazón o cambios de color.',
  },
  {
    icon: 'droplet',
    titulo: 'Lavalos y secalos bien',
    texto:
      'Usá agua tibia (probala con el codo, no con el pie) y jabón suave. Secá con cuidado, sobre todo entre los dedos.',
  },
  {
    icon: 'shield',
    titulo: 'Hidratá, pero no entre los dedos',
    texto: 'Aplicá crema en la planta y el empeine para evitar grietas. Entre los dedos la humedad favorece infecciones.',
  },
  {
    icon: 'shoe',
    titulo: 'Usá calzado cómodo y cerrado',
    texto:
      'Revisá el interior antes de ponértelo. Evitá caminar descalzo, incluso en tu casa. Usá medias sin costuras y sin elástico apretado.',
  },
  {
    icon: 'scissors',
    titulo: 'Cortá las uñas en línea recta',
    texto: 'No cortes callos ni durezas por tu cuenta ni uses callicidas. Consultá a podología.',
  },
  {
    icon: 'thermo',
    titulo: 'Cuidado con el calor y el frío',
    texto:
      'No uses bolsas de agua caliente ni estufas cerca de los pies: con neuropatía podés no sentir una quemadura.',
  },
  {
    icon: 'activity',
    titulo: 'Controlá tu glucemia',
    texto: 'Mantener la glucemia y la HbA1c en los valores que te indicó tu médico protege los nervios y la circulación.',
  },
  {
    icon: 'alert',
    titulo: 'Consultá enseguida si…',
    texto:
      'notás una herida que no cicatriza, una zona más caliente, roja o hinchada, dolor nuevo o secreción. No esperes al próximo control.',
  },
]);

module.exports = { SELF_CARE };
