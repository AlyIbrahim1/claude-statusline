use std::io::Read;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

fn main() {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input).ok();
        tx.send(input).ok();
    });
    let input = match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(s) => s,
        Err(_) => return,
    };
    if let Some(out) = render(&input) {
        print!("{}", out);
    }
}

fn render(_input: &str) -> Option<String> {
    Some(String::from("placeholder"))
}
