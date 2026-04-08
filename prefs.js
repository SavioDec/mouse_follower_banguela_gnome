import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * BanguelaPreferences - Interface de configuração baseada em Libadwaita (GTK4).
 */
export default class BanguelaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Carrega as definições do esquema GSettings
        const settings = this.getSettings('org.gnome.shell.extensions.banguela');
        
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({ title: 'Aparência e Movimento' });
        page.add(group);

        // Seletor de Tamanho
        const sizeRow = new Adw.SpinRow({
            title: 'Tamanho do Pet (pixels)',
            adjustment: new Gtk.Adjustment({ lower: 14, upper: 200, step_increment: 2 }),
            digits: 0
        });
        group.add(sizeRow);
        // Bind bidirecional: a UI altera o banco de dados e o banco de dados altera a UI
        settings.bind('pet-size', sizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Seletor de Velocidade de Caminhada
        const walkRow = new Adw.SpinRow({
            title: 'Velocidade de Caminhada',
            adjustment: new Gtk.Adjustment({ lower: 0.5, upper: 100.0, step_increment: 0.1 }),
            digits: 1
        });
        group.add(walkRow);
        settings.bind('walk-speed', walkRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Seletor de Velocidade de Voo
        const flyRow = new Adw.SpinRow({
            title: 'Velocidade de Voo',
            adjustment: new Gtk.Adjustment({ lower: 1.0, upper: 100.0, step_increment: 0.5 }),
            digits: 1
        });
        group.add(flyRow);
        settings.bind('fly-speed', flyRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        window.add(page);
    }
}