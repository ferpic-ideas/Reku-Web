import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from '../src/config.mjs';
import { ypfBrand as brand } from '../src/agreement-brand.mjs';

const output = join(root, 'agenda/brands/ypf-os/guia-pacientes.pdf');
await mkdir(join(root, 'agenda/brands/ypf-os'), { recursive: true });
const doc = new PDFDocument({ size: 'A4', margins: {top:36,left:36,right:36,bottom:20}, autoFirstPage: false,
  info: { Title: 'YPF Obra Social - Guía para pacientes', Author: 'Reku' } });
const stream = createWriteStream(output); doc.pipe(stream);
doc.registerFont('DIN', join(root, brand.fontRegular));
doc.registerFont('DIN-Medium', join(root, brand.fontMedium));
const reku = await sharp(join(root, 'images/logo-reku.svg')).png().toBuffer();
const text = (value, x, y, width, size=10, color=brand.navy, font='DIN') => {
  doc.font(font).fontSize(size).fillColor(color).text(value,x,y,{width,lineGap:2});
};
const steps = [
  ['Accedé a tus ejercicios', 'Ingresá a Reku y consultá los ejercicios asignados.', [0]],
  ['Prepará tu espacio', 'Reuní los materiales indicados y pulsá Empezar.', [2]],
  ['Realizá tu rutina', 'Seguí tus ejercicios y, al finalizar, pulsá Terminar.', [10]],
  ['Contanos cómo te fue', 'Evaluá tu dolor y esfuerzo al terminar cada ejercicio.', [4,6,8]],
  ['Consultá tu progreso', 'Revisá tu evolución y desbloqueá logros.', [14]],
  ['Hablá con tu profesional', 'Consultá tus dudas por el chat de la plataforma.', [12]],
  ['Respondé los cuestionarios', 'Tu profesional puede enviarte un cuestionario clínico.', [20]],
  ['Completá el programa', 'En la última semana, completá la encuesta de satisfacción.', [16,18]],
];
for (let page=0;page<2;page++) {
  doc.addPage();
  const gradient=doc.linearGradient(0,0,595,0).stop(0,brand.blue).stop(1,brand.navy);
  doc.rect(0,0,595.28,9).fill(gradient);
  doc.image(join(root,'agenda/brands/ypf-os/logo.png'),36,35,{width:218});
  text('Servicio brindado por',400,33,159,9,'#53617b'); doc.image(reku,480,47,{width:70});
  text(page ? 'Rehabilitación digital' : 'Rehabilitación mixta',36,99,523,27,brand.navy,'DIN-Medium');
  text(page ? 'Realizá tus sesiones de fisioterapia desde casa.' : 'Combiná tus sesiones en consulta con ejercicios desde casa.',36,135,523,12);
  doc.rect(36,163,523,3).fill(brand.mint);
  text(page
    ? 'Tu recuperación sigue un plan de ejercicio terapéutico online, gestionado y supervisado por tu kinesiólogo. Tu actividad queda registrada para que pueda acompañar tu progreso y adaptar el plan a tu evolución.'
    : 'Tu tratamiento combina sesiones presenciales con tu kinesiólogo y ejercicios online. Ambas partes son importantes. Tu actividad en la plataforma queda registrada para que tu profesional pueda supervisar tu progreso y adaptar el plan a tu evolución.',
    36,180,523,10.5);
  text('Tu guía paso a paso',36,235,523,17,brand.blue,'DIN-Medium');
  text('Cuando tu profesional indique comenzar la terapia online, recibirás un correo de bienvenida con el acceso a la plataforma.',36,262,523,10);
  steps.forEach(([title,copy,images],i)=>{
    const x=36+(i%4)*134, y=302+Math.floor(i/4)*169;
    doc.roundedRect(x,y,121,167,8).fill('#f4f7fc');
    doc.circle(x+13,y+13,9).fill(brand.mint);text(String(i+1),x+10,y+6,15,10,brand.navy,'DIN-Medium');
    const imageWidth=Math.min(40,100/images.length), imageHeight=imageWidth*374/183;
    images.forEach((id,j)=>doc.image(join(root,`assets/ypf-guide/screen-${id}.png`),x+(121-images.length*imageWidth)/2+j*imageWidth,y+26,{fit:[imageWidth,imageHeight],align:'center'}));
    text(title,x+8,y+108,105,8.5,brand.blue,'DIN-Medium');
    text(copy,x+8,y+130,105,8);
  });
  doc.rect(36,650,4,101).fill(brand.mint);
  text('Recordá',50,649,509,13,brand.blue,'DIN-Medium');
  const reminders=[
    'Los ejercicios son planificados y supervisados por un kinesiólogo profesional.',
    'Las sesiones online forman parte de tu tratamiento.',
    'Tu actividad queda registrada y se incluye en tu informe médico.',
    'Si no accedés a la plataforma o no realizás los ejercicios durante dos semanas, se dará de alta el tratamiento.',
  ];
  let y=672;
  for(const reminder of reminders){text('•',50,y,10,9);text(reminder,62,y,490,9);y=doc.y+4;}
  doc.moveTo(36,770).lineTo(559,770).strokeColor('#d8e1ef').stroke();
  text('Para dudas médicas o sobre tus ejercicios, consultá a tu profesional.',36,782,523,9);
  text('Soporte Reku: WhatsApp +54 911 3209-8236  |  soporte@reku.io',36,798,510,9,brand.blue);
  doc.link(36,798,245,14,'https://wa.me/5491132098236');doc.link(287,798,180,14,'mailto:soporte@reku.io');
  text(String(page+1),545,798,14,9,'#53617b');
}
doc.end(); await new Promise((resolve,reject)=>{stream.on('finish',resolve);stream.on('error',reject);});
console.log(output);
