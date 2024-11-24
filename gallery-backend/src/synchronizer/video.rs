use crate::executor::compressor::video_compressor::generate_compressed;

use crate::public::abstract_data::AbstractData;
use crate::public::error_data::{handle_error, ErrorData};
use crate::public::redb::{ALBUM_TABLE, DATA_TABLE};
use crate::public::tree::start_loop::SHOULD_RESET;
use crate::public::tree::TREE;

use arrayvec::ArrayString;
use log::info;
use rayon::iter::{IntoParallelRefIterator, ParallelIterator};
use redb::ReadableTable;
use std::panic::Location;
use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
use tokio;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

pub static VIDEO_QUEUE_SENDER: OnceLock<UnboundedSender<Vec<ArrayString<64>>>> = OnceLock::new();

pub fn start_video_channel() {
    let (video_queue_sender, mut video_queue_receiver) =
        unbounded_channel::<Vec<ArrayString<64>>>();
    VIDEO_QUEUE_SENDER.set(video_queue_sender).unwrap();

    tokio::task::spawn(async move {
        while let Some(list_of_video_hash) = video_queue_receiver.recv().await {
            tokio::task::spawn_blocking(move || {
                // Deduplicate the paths
                let unique_hashes: HashSet<_> = list_of_video_hash.into_iter().collect();
                let hash_vec: Vec<_> = unique_hashes.into_iter().collect();

                let read_table = TREE.read_tree_api();
                let database_vec = hash_vec.into_iter().filter_map(|hash| {
                    match read_table.get(&*hash).unwrap() {
                        Some(guard) => {
                            // If this file is already in database
                            let database = guard.value();
                            Some(database)
                        }
                        None => None,
                    }
                });

                database_vec.for_each(|mut database| match generate_compressed(&mut database) {
                    Ok(_) => {
                        database.pending = false;
                        let write_txn = TREE.in_disk.begin_write().unwrap();
                        {
                            let mut write_table = write_txn.open_table(DATA_TABLE).unwrap();
                            write_table.insert(&*database.hash, &database).unwrap();
                        }
                        write_txn.commit().unwrap();
                        SHOULD_RESET.store(true, Ordering::SeqCst);
                    }
                    Err(error) => {
                        handle_error(ErrorData::new(
                            error.to_string(),
                            format!("An error occurred while processing file",),
                            Some(database.hash),
                            Some(database.imported_path()),
                            Location::caller(),
                            Some(database),
                        ));
                    }
                })
            })
            .await
            .unwrap();
        }
    });
}