import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class BanguelaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.banguela');
        
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({ title: 'Aparência e Movimento' });
        page.add(group);

        const sizeRow = new Adw.SpinRow({
            title: 'Tamanho do Pet (pixels)',
            adjustment: new Gtk.Adjustment({ lower: 14, upper: 200, step_increment: 2 }),
            digits: 0
        });
        group.add(sizeRow);
        settings.bind('pet-size', sizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const walkRow = new Adw.SpinRow({
            title: 'Velocidade de Caminhada',
            adjustment: new Gtk.Adjustment({ lower: 0.5, upper: 100.0, step_increment: 0.5 }),
            digits: 1
        });
        group.add(walkRow);
        settings.bind('walk-speed', walkRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const flyRow = new Adw.SpinRow({
            title: 'Velocidade de Voo',
            adjustment: new Gtk.Adjustment({ lower: 1.0, upper: 100.0, step_increment: 1.0 }),
            digits: 1
        });
        group.add(flyRow);
        settings.bind('fly-speed', flyRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const dynamicRow = new Adw.SwitchRow({
            title: 'Aceleração dinâmica no voo',
            subtitle: 'Voa mais rápido quanto mais longe o mouse; a Velocidade de Voo vira o máximo'
        });
        group.add(dynamicRow);
        settings.bind('fly-dynamic-speed', dynamicRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const fullSpeedRow = new Adw.SpinRow({
            title: 'Distância da velocidade máxima (pixels)',
            subtitle: 'A partir dessa distância do mouse o voo usa a velocidade máxima',
            adjustment: new Gtk.Adjustment({ lower: 300, upper: 3000, step_increment: 50 }),
            digits: 0
        });
        group.add(fullSpeedRow);
        settings.bind('fly-full-speed-distance', fullSpeedRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('fly-dynamic-speed', fullSpeedRow, 'sensitive', Gio.SettingsBindFlags.GET);

        const opacityRow = new Adw.SpinRow({
            title: 'Opacidade ao sobrepor o mouse',
            subtitle: '1.0 = Sólido, 0.0 = Invisível',
            adjustment: new Gtk.Adjustment({ lower: 0.0, upper: 1.0, step_increment: 0.1 }),
            digits: 2
        });
        group.add(opacityRow);
        settings.bind('hover-opacity', opacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        window.add(page);
    }
    
}
